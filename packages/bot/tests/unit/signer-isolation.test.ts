import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Solana trading signer configuration isolation', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('does not use treasury, typo, or legacy credentials as a trading signer', async () => {
    vi.resetModules();
    vi.stubEnv('SOLANA_TREASURY_SECRET_KEY', 'redacted-test-value');
    vi.stubEnv('SOLANA_PRIVATE_KEY_BASE58Y_BASE58', 'redacted-test-value');
    vi.stubEnv('SOLANA_ARB_SECRET_KEY', 'redacted-test-value');
    const { solanaExecutorConfig } = await import('../../src/solana/config');
    expect(solanaExecutorConfig.privateKeyBase58).toBe('');
  });

  it('accepts the explicit trading signer configuration', async () => {
    vi.resetModules();
    vi.stubEnv('SOLANA_PRIVATE_KEY_BASE58', 'explicit-trading-signer');
    const { solanaExecutorConfig } = await import('../../src/solana/config');
    expect(solanaExecutorConfig.privateKeyBase58).toBe('explicit-trading-signer');
  });
});