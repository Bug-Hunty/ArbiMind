import { loadEnv } from './bootstrapEnv';
import { assertRequiredNodeVersion } from './RuntimeVersionGuard';
import { assertExecutionProvenance, readRuntimeProvenance } from './solana/RuntimeProvenance';
import { readEvmSubsystemState } from './config/subsystems';

console.error(`[BOOT] ArbiMind bot process start pid=${process.pid} node=${process.version} ts=${new Date().toISOString()}`);

try {
  const runtime = assertRequiredNodeVersion();
  console.error(
    `[BOOT] runtime guard passed requiredNodeVersion=${runtime.requiredNodeVersion} ` +
      `actualNodeVersion=${runtime.actualNodeVersion}`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[FATAL] ${message}`);
  process.exitCode = 1;
  throw error;
}

try {
  loadEnv();
  console.error(`[BOOT] env bootstrap completed ts=${new Date().toISOString()}`);
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`env bootstrap failed: ${message}`);
}

// Check before services start and outside the LOG_ONLY graceful-error handler.
try {
  const provenance = readRuntimeProvenance();
  assertExecutionProvenance(provenance, false);
  console.error(
    `[BOOT] provenance PASS sourceSha=${provenance.sourceSha} runtimeSha=${provenance.runtimeSha} ` +
      `node=${provenance.nodeVersion}`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[FATAL] ${message}`);
  process.exitCode = 1;
  throw error;
}

function isValidPrivateKey(value: string): boolean {
  return value.length === 66 && value.startsWith('0x');
}

function normalizeEnvValue(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isEnvTrue(value: string | undefined): boolean {
  const normalized = normalizeEnvValue(value).toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    const onSignal = () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

async function main(): Promise<void> {
  try {
    const { scannerEnabled: evmScannerEnabled, enabled: evmEnabled } = readEvmSubsystemState();
    console.error('[BOOT] importing ethers');
    const { ethers } = await import('ethers');
    console.error('[BOOT] imported ethers');

    console.error('[BOOT] importing config/index');
    const configModule = await import('./config/index.js');
    console.error('[BOOT] imported config/index');

    console.error('[BOOT] importing config/identity');
    const identityModule = await import('./config/identity.js');
    console.error('[BOOT] imported config/identity');

    console.error('[BOOT] importing utils/Logger');
    const loggerModule = await import('./utils/Logger.js');
    console.error('[BOOT] imported utils/Logger');

    console.error('[BOOT] importing solana/Scanner');
    const solanaModule = await import('./solana/Scanner.js');
    console.error('[BOOT] imported solana/Scanner');

    console.error('[BOOT] importing solana/config');
    const solanaConfigModule = await import('./solana/config.js');
    console.error('[BOOT] imported solana/config');

    console.error('[BOOT] importing solana/solanaRpcGuard');
    const solanaRpcGuardModule = await import('./solana/solanaRpcGuard.js');
    console.error('[BOOT] imported solana/solanaRpcGuard');

    const { refreshConfig, validateConfig, config } = configModule;
    const { getIdentitySource, shortAddress } = identityModule;
    const { Logger } = loggerModule;
    const { SolanaScanner } = solanaModule;
    const { solanaConfig, solanaExecutorConfig } = solanaConfigModule;
    const { checkSolanaRpcHealth } = solanaRpcGuardModule;

    const logger = new Logger('Main');

    // Refresh config with loaded env vars
    refreshConfig();
    
    logger.info('🚀 Starting ArbiMind Arbitrage Bot...');
    
    // Validate configuration
    validateConfig();
    logger.info('✅ Configuration validated');

    // No-scanner/no-execution mode is a clean exit, without providers or service timers.
    if (!evmEnabled && !solanaConfig.enabled) {
      logger.info('No subsystems enabled; exiting without starting services');
      return;
    }

    // Log selected chain
    logger.info(`📡 Selected chain: ${config.evmChain} (chainId=${config.evmChainId})`);
    logger.info(`🌐 RPC: ${config.ethereumRpcUrl.split('/').slice(0, 3).join('/')}/...`);
    if (config.logOnly) {
      logger.info('📊 Running in LOG_ONLY mode (no trades will be executed)');
    }

    if (!evmScannerEnabled) {
      logger.warn('⏸️ EVM scanner disabled by EVM_SCANNER_ENABLED=false; Solana scanner remains active');
    }

    const privateKey = config.privateKey?.trim() || '';
    const walletAddressEnv = config.walletAddress?.trim() || '';
    const hasPrivateKey = evmEnabled && isValidPrivateKey(privateKey);
    const identitySource = getIdentitySource({
      hasWallet: hasPrivateKey,
      walletAddress: walletAddressEnv,
    });
    const effectiveAddress = hasPrivateKey
      ? new ethers.Wallet(privateKey).address
      : walletAddressEnv;

    logger.info(
      `🔐 Identity: ${identitySource}${effectiveAddress ? ` (${shortAddress(effectiveAddress)})` : ''} | mode=${config.logOnly ? 'LOG_ONLY' : 'LIVE'}`
    );

    if (config.canaryEnabled) {
      logger.warn('🧪 Running in CANARY mode', {
        canaryNotionalEth: config.canaryNotionalEth,
        canaryMaxDailyLossEth: config.canaryMaxDailyLossEth
      });
    }

    const effectiveSolanaNotionalUsd = solanaExecutorConfig.canaryMode
      ? Math.min(solanaExecutorConfig.maxNotionalUsd, 5)
      : solanaExecutorConfig.maxNotionalUsd;
    logger.info('🧮 Solana notional gate', {
      configuredMaxNotionalUsd: solanaExecutorConfig.maxNotionalUsd,
      effectiveMaxNotionalUsd: effectiveSolanaNotionalUsd,
      canaryMode: solanaExecutorConfig.canaryMode,
    });

    const solanaRpcGuard = solanaConfig.enabled
      ? await checkSolanaRpcHealth(solanaExecutorConfig)
      : { config: solanaExecutorConfig, healthy: false, forced: false, slotAtCheck: undefined };
    Object.assign(solanaExecutorConfig, solanaRpcGuard.config);
    if (solanaRpcGuard.forced) {
      logger.error('⚠️ Solana trading was enabled but RPC is unhealthy; forcing LOG_ONLY mode');
    }

    // Structured boot summary for observability
    console.log('[BOOT_SUMMARY]', JSON.stringify({
      ts: new Date().toISOString(),
      network: config.network,
      evmChain: config.evmChain,
      chainId: config.evmChainId,
      evmScannerEnabled,
      mode: config.logOnly ? 'LOG_ONLY' : 'LIVE',
      canary: config.canaryEnabled,
      v3Enabled: !isEnvTrue(process.env['ENABLE_V3_QUOTES'] === 'false' ? 'false' : undefined),
      scanIntervalMs: config.scanIntervalMs,
      minProfitEth: config.minProfitEth,
      minProfitUsd: config.minProfitUsd,
      maxGasPriceGwei: config.maxGasPriceGwei,
      maxSlippageBps: config.maxSlippageBps,
      minEdgeBps: config.minEdgeBps,
      swapAmountEth: config.swapAmountEth,
      solanaEnabled: Boolean(process.env['SOLANA_SCANNER_ENABLED'] === 'true'),
      solanaTradingEnabled: solanaExecutorConfig.tradingEnabled,
      solanaLogOnly: solanaExecutorConfig.logOnly,
      solanaCanaryMode: solanaExecutorConfig.canaryMode,
      solanaConfiguredMaxNotionalUsd: solanaExecutorConfig.maxNotionalUsd,
      solanaEffectiveMaxNotionalUsd: effectiveSolanaNotionalUsd,
      solanaRpcHealthyAtBoot: solanaRpcGuard.healthy,
      solanaRpcGuardForcedLogOnly: solanaRpcGuard.forced,
      solanaRpcSlotAtCheck: solanaRpcGuard.slotAtCheck,
    }));

    // Inactive EVM must not construct providers, wallets or execution services.
    let bot: import('./services/ArbitrageBot').ArbitrageBot | undefined;
    if (evmEnabled) {
      console.error('[BOOT] importing services/ArbitrageBot');
      const { ArbitrageBot } = await import('./services/ArbitrageBot.js');
      console.error('[BOOT] imported services/ArbitrageBot');
      bot = new ArbitrageBot();
    } else {
      console.error('[BOOT] EVM subsystem disabled; startup skipped');
    }
    
    // Create and start the Solana scanner
    const solanaScanner = solanaConfig.enabled ? new SolanaScanner() : undefined;
    solanaScanner?.start();
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
      logger.info('🛑 Received SIGINT, shutting down gracefully...');
      bot?.stop();
      solanaScanner?.stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      logger.info('🛑 Received SIGTERM, shutting down gracefully...');
      bot?.stop();
      solanaScanner?.stop();
      process.exit(0);
    });

    // Start scanners based on runtime toggles
    if (evmScannerEnabled) {
      await bot!.start();
    } else {
      logger.info(solanaConfig.enabled
        ? 'EVM scanner start skipped (EVM_SCANNER_ENABLED=false); process kept alive by Solana scanner loop'
        : 'All scanners disabled; waiting for shutdown');
      await waitForShutdownSignal();
    }

  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[FATAL] bot startup error @ ${new Date().toISOString()} error=${message}`);

    process.exit(1);
  }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception', {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection', {
    reason: reason instanceof Error ? reason.message : reason,
    promise: promise
  });
  process.exit(1);
});

process.on('exit', (code) => {
  if (code !== 0) {
    console.error(`arbimind-bot exiting with non-zero code=${code}`);
  }
});

// Start the application
main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FATAL] main() rejected @ ${new Date().toISOString()} error=${message}`);
  process.exit(1);
});
