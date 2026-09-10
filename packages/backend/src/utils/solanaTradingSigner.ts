import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/** Trading identity is explicit and independent from treasury diagnostics. */
export function readTradingSigner(): Keypair {
  const raw = process.env.SOLANA_PRIVATE_KEY_BASE58?.trim();
  if (!raw) throw new Error('Missing SOLANA_PRIVATE_KEY_BASE58 for trading execution');
  try {
    const bytes = bs58.decode(raw);
    if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
    if (bytes.length === 32) return Keypair.fromSeed(bytes);
  } catch { /* Do not expose input through a decoder error. */ }
  throw new Error('Invalid SOLANA_PRIVATE_KEY_BASE58 trading signer');
}
