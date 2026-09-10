import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { parseTradingSigner, validateExecutionSigner } from '../../src/solana/signingIdentity';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('explicit Solana trading identity', () => {
  it('does not inherit any treasury or legacy key when the explicit value is absent', async () => {
    vi.stubEnv('SOLANA_PRIVATE_KEY_BASE58', undefined);
    vi.stubEnv('SOLANA_TREASURY_SECRET_KEY', 'treasury-test-sentinel');
    vi.stubEnv('SOLANA_ARB_SECRET_KEY', 'legacy-test-sentinel');
    // Construct the historical typo only in this negative test, never in a lookup.
    vi.stubEnv(['SOLANA_PRIVATE_KEY', 'BASE58Y', 'BASE58'].join('_'), 'typo-test-sentinel');
    const { solanaExecutorConfig } = await import('../../src/solana/config');
    expect(solanaExecutorConfig.privateKeyBase58).toBe('');
    expect(() => validateExecutionSigner({ ...solanaExecutorConfig, tradingEnabled: true, logOnly: false })).toThrow('Missing SOLANA_PRIVATE_KEY_BASE58');
  });

  it('uses only the explicit value when treasury and legacy variables also exist', async () => {
    vi.stubEnv('SOLANA_PRIVATE_KEY_BASE58', ' explicit-test-sentinel ');
    vi.stubEnv('SOLANA_TREASURY_SECRET_KEY', 'treasury-test-sentinel');
    vi.stubEnv('SOLANA_ARB_SECRET_KEY', 'legacy-test-sentinel');
    const { solanaExecutorConfig } = await import('../../src/solana/config');
    expect(solanaExecutorConfig.privateKeyBase58).toBe('explicit-test-sentinel');
  });

  it('rejects invalid execution credentials with a sanitized error', () => {
    const invalid = '[private-material-is-never-echoed]';
    expect(() => validateExecutionSigner({ tradingEnabled: true, logOnly: false, privateKeyBase58: invalid })).toThrow('Invalid SOLANA_PRIVATE_KEY_BASE58');
    try { parseTradingSigner(invalid); } catch (error) { expect(String(error)).not.toContain(invalid); }
  });

  it('does not require or parse a signer in LOG_ONLY', () => {
    expect(() => validateExecutionSigner({ tradingEnabled: true, logOnly: true, privateKeyBase58: '' })).not.toThrow();
    expect(() => validateExecutionSigner({ tradingEnabled: false, logOnly: false, privateKeyBase58: '' })).not.toThrow();
  });

  it('parses documented encodings of an unfunded test identity without signing', () => {
    const fixture = Keypair.generate();
    const seed = fixture.secretKey.slice(0, 32);
    for (const value of [bs58.encode(fixture.secretKey), bs58.encode(seed), Buffer.from(seed).toString('hex'), JSON.stringify([...fixture.secretKey]), JSON.stringify([...seed])]) {
      expect(parseTradingSigner(value).keypair.publicKey.equals(fixture.publicKey)).toBe(true);
    }
  });
});
