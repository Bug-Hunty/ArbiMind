import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readEvmSubsystemState } from '../../src/config/subsystems';

// Load the real address/RPC dependencies during collection, before per-case timers.
import 'ethers';
import 'viem/chains';
import '@solana/web3.js';

// Config tests exercise production validators without opening a file transport on every import.
vi.mock('../../src/utils/Logger', () => ({
  Logger: class {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
  },
}));

const disabledEvmEnv = {
  NETWORK: 'mainnet',
  EVM_CHAIN: 'ethereum',
  EVM_SCANNER_ENABLED: 'false',
  EVM_TRADING_ENABLED: 'false',
  SOLANA_SCANNER_ENABLED: 'true',
  SOLANA_TRADING_ENABLED: 'false',
  SOLANA_LOG_ONLY: 'true',
  LOG_ONLY: 'true',
  BOT_LOG_ONLY: 'true',
  ETHEREUM_RPC_URL: '',
  ARBITRUM_RPC_URL: '',
  POLYGON_RPC_URL: '',
  EVM_RPC_URL: '',
  SOLANA_RPC_URL_MAINNET_BETA: '',
  SOLANA_RPC_URL: '',
};

describe('disabled EVM startup isolation', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const [key, value] of Object.entries(disabledEvmEnv)) vi.stubEnv(key, value);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('accepts Solana-only config with the unchanged invalid Ethereum Curve factory', async () => {
    const { config, validateConfig, DEX_CONFIG, ENABLED_DEXES } = await import('../../src/config');
    const { solanaConfig } = await import('../../src/solana/config');
    expect(config.logOnly).toBe(true);
    expect(config.evmTradingEnabled).toBe(false);
    expect(solanaConfig.enabled).toBe(true);
    expect(DEX_CONFIG).toEqual({});
    expect(ENABLED_DEXES).toEqual([]);
    expect(() => validateConfig()).not.toThrow();
  });

  it.each(['EVM_SCANNER_ENABLED', 'EVM_TRADING_ENABLED'])(
    'keeps invalid Curve fatal when %s is true, including LOG_ONLY', async (flag) => {
      vi.stubEnv(flag, 'true');
      await expect(import('../../src/config')).rejects.toThrow('[CONFIG_FATAL] Ethereum DEX CURVE.factory');
    },
  );

  it.each(['EVM_SCANNER_ENABLED', 'EVM_TRADING_ENABLED'])(
    'keeps the existing enabled default when %s is unset', async (flag) => {
      vi.stubEnv(flag, undefined);
      await expect(import('../../src/config')).rejects.toThrow('[CONFIG_FATAL] Ethereum DEX CURVE.factory');
    },
  );

  it.each([
    ['SEPOLIA_UNISWAP_V2_ROUTER', 'SEPOLIA_UNISWAP_V2_ENABLED', 'UNISWAP_V2.router'],
    ['SEPOLIA_SUSHISWAP_FACTORY', 'SEPOLIA_SUSHISWAP_ENABLED', 'SUSHISWAP.factory'],
  ])('ignores inactive %s but validates it when EVM is enabled', async (address, enabled, field) => {
    vi.stubEnv('NETWORK', 'testnet');
    vi.stubEnv(address, 'invalid-venue-address');
    vi.stubEnv(enabled, 'true');
    const inactive = await import('../../src/config');
    expect(() => inactive.validateConfig()).not.toThrow();
    expect(inactive.DEX_CONFIG).toEqual({});

    vi.stubEnv('EVM_SCANNER_ENABLED', 'true');
    vi.resetModules();
    await expect(import('../../src/config')).rejects.toThrow(`[CONFIG_FATAL] Sepolia DEX ${field}`);
  });

  it('isolates invalid inactive EVM tokens as well as venues', async () => {
    vi.stubEnv('NETWORK', 'testnet');
    vi.stubEnv('SEPOLIA_WETH_ADDRESS', 'invalid-token-address');
    const inactive = await import('../../src/config');
    expect(inactive.ALLOWLISTED_TOKENS).toEqual({});
    expect(inactive.TOKEN_PAIRS).toEqual([]);
    expect(() => inactive.validateConfig()).not.toThrow();

    vi.stubEnv('EVM_SCANNER_ENABLED', 'true');
    vi.resetModules();
    await expect(import('../../src/config')).rejects.toThrow('[CONFIG_FATAL] Sepolia token WETH');
  });

  it('keeps mandatory EVM RPC validation when EVM is active', async () => {
    vi.stubEnv('EVM_CHAIN', 'arbitrum');
    vi.stubEnv('EVM_SCANNER_ENABLED', 'true');
    const { validateConfig } = await import('../../src/config');
    expect(() => validateConfig()).toThrow('Missing required configuration: ethereumRpcUrl');
  });

  it('does not bypass the existing Solana RPC guard for invalid enabled Solana config', async () => {
    vi.stubEnv('SOLANA_RPC_URL', 'invalid-rpc-url');
    const { validateConfig } = await import('../../src/config');
    const { solanaConfig, solanaExecutorConfig } = await import('../../src/solana/config');
    const { checkSolanaRpcHealth } = await import('../../src/solana/solanaRpcGuard');
    expect(() => validateConfig()).not.toThrow();
    expect(solanaConfig.enabled).toBe(true);
    await expect(checkSolanaRpcHealth(solanaExecutorConfig)).rejects.toThrow('Endpoint URL');
  });

  it('accepts no-scanner/no-execution config for a clean exit without services', async () => {
    vi.stubEnv('SOLANA_SCANNER_ENABLED', 'false');
    const { validateConfig, ENABLED_DEXES } = await import('../../src/config');
    const { solanaConfig } = await import('../../src/solana/config');
    expect(readEvmSubsystemState().enabled).toBe(false);
    expect(solanaConfig.enabled).toBe(false);
    expect(ENABLED_DEXES).toEqual([]);
    expect(() => validateConfig()).not.toThrow();
  });

  it.each(['false', '0', 'no', 'off', ' FALSE ', '"false"'])(
    'uses the existing explicit-false spelling %s consistently', (value) => {
      expect(readEvmSubsystemState({ EVM_SCANNER_ENABLED: value, EVM_TRADING_ENABLED: value })).toEqual({
        scannerEnabled: false, tradingEnabled: false, enabled: false,
      });
    },
  );
});
