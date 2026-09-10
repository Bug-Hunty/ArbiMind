import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { resolveTradingKeypairFromEnv } from '../services/SolanaExecutor';

describe('Solana trading signer isolation', () => {
  const tradingKey = bs58.encode(Keypair.generate().secretKey);

  it.each([
    { SOLANA_TREASURY_SECRET_KEY: tradingKey },
    { TREASURY_PRIVATE_KEY: tradingKey },
    { SOLANA_PRIVATE_KEY_BASE58Y_BASE58: tradingKey },
  ])('rejects non-trading credential %j', (env) => {
    expect(() => resolveTradingKeypairFromEnv(env)).toThrow('No trading keypair configured');
  });

  it('accepts only the explicit trading signer', () => {
    const result = resolveTradingKeypairFromEnv({ SOLANA_TRADING_PRIVATE_KEY_BASE58: tradingKey });
    expect(result.source).toBe('SOLANA_TRADING_PRIVATE_KEY_BASE58');
    expect(result.keypair.publicKey.toBase58()).toBeTruthy();
  });

  it('rejects a missing trading signer', () => {
    expect(() => resolveTradingKeypairFromEnv({})).toThrow('No trading keypair configured');
  });
});