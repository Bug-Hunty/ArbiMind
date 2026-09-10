import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
beforeAll(async () => {
  await Promise.all([import('ethers'), import('viem/chains'), import('winston')]);
}, 60_000);
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('Solana-only startup independence', () => {
  it('does not require EVM RPC, wallet or venue configuration when its scanner is disabled', async () => {
    vi.stubEnv('EVM_SCANNER_ENABLED', 'false');
    vi.stubEnv('EVM_CHAIN', 'ethereum');
    vi.stubEnv('NETWORK', 'mainnet');
    for (const name of ['ETHEREUM_RPC_URL', 'ARBITRUM_RPC_URL', 'POLYGON_RPC_URL', 'EVM_RPC_URL', 'PRIVATE_KEY', 'TREASURY_ADDRESS']) vi.stubEnv(name, undefined);
    vi.stubEnv('WALLET_ADDRESS', 'invalid-irrelevant-evm-address');
    const { validateConfig, DEX_CONFIG } = await import('../../src/config');
    expect(() => validateConfig()).not.toThrow();
    expect(DEX_CONFIG).toEqual({});
  });

  it('ignores invalid disabled Ethereum venue placeholders while keeping enabled venues', async () => {
    vi.stubEnv('EVM_SCANNER_ENABLED', 'true');
    vi.stubEnv('EVM_CHAIN', 'ethereum');
    vi.stubEnv('NETWORK', 'mainnet');
    const { DEX_CONFIG, ENABLED_DEXES } = await import('../../src/config/dexes');
    expect(Object.values(DEX_CONFIG).some((dex) => !dex.enabled)).toBe(true);
    expect(ENABLED_DEXES.length).toBeGreaterThan(0);
  });

  it('still requires an EVM RPC when the EVM scanner is enabled', async () => {
    vi.stubEnv('EVM_SCANNER_ENABLED', 'true');
    vi.stubEnv('EVM_CHAIN', 'arbitrum');
    for (const name of ['ETHEREUM_RPC_URL', 'ARBITRUM_RPC_URL', 'POLYGON_RPC_URL', 'EVM_RPC_URL']) vi.stubEnv(name, undefined);
    const { validateConfig } = await import('../../src/config');
    expect(() => validateConfig()).toThrow('Missing required configuration: ethereumRpcUrl');
  });

  it('returns a nonzero exit status for a fatal LOG_ONLY startup without making an RPC call', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'arbimind-startup-'));
    const env: Record<string, string> = { LOG_ONLY: 'true', SOLANA_LOG_ONLY: 'true', SOLANA_TRADING_ENABLED: 'false', SOLANA_SCANNER_ENABLED: 'false', EVM_SCANNER_ENABLED: 'true', EVM_CHAIN: 'arbitrum', NETWORK: 'mainnet' };
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key]!;
    try {
      // Empty working directory prevents loading the operator's .env files.
      // Missing EVM RPC fails validation before any scanner/network startup.
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, path.resolve(__dirname, '../../src/index.ts')], {
        // A fresh process must load the EVM SDK's full chain registry from
        // disk; keep that integration startup budget separate from unit tests.
        cwd: fixture, env, encoding: 'utf8', timeout: 75_000,
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('[FATAL] bot startup error');
      expect(result.stderr).toContain('Missing required configuration: ethereumRpcUrl');
    } finally {
      const resolved = fs.realpathSync(fixture);
      if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('arbimind-startup-')) throw new Error('Unexpected startup fixture path');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 90_000);
});
