import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export interface TradingSigner {
  keypair: Keypair;
  format: 'base58-64' | 'base58-32' | 'hex' | 'json-array-64' | 'json-array-32';
}

/** One explicit trading value; parsing never consults treasury or legacy envs. */
export function parseTradingSigner(value: string): TradingSigner {
  const raw = value.trim();
  if (!raw) throw new Error('Missing SOLANA_PRIVATE_KEY_BASE58 for execution-capable mode');

  try {
    const bytes = bs58.decode(raw);
    if (bytes.length === 64) return { keypair: Keypair.fromSecretKey(bytes), format: 'base58-64' };
    if (bytes.length === 32) return { keypair: Keypair.fromSeed(bytes), format: 'base58-32' };
  } catch { /* Validate other documented encodings without exposing parser errors. */ }

  try {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      return { keypair: Keypair.fromSeed(Uint8Array.from(Buffer.from(raw, 'hex'))), format: 'hex' };
    }
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255)) {
        const bytes = Uint8Array.from(parsed as number[]);
        if (bytes.length === 64) return { keypair: Keypair.fromSecretKey(bytes), format: 'json-array-64' };
        if (bytes.length === 32) return { keypair: Keypair.fromSeed(bytes), format: 'json-array-32' };
      }
    }
  } catch { /* A JSON parser error may quote secret input; never log it. */ }

  throw new Error('Invalid SOLANA_PRIVATE_KEY_BASE58: unsupported or invalid trading signer');
}

/** Run before RPC fallback can change execution mode. This never signs. */
export function validateExecutionSigner(config: {
  tradingEnabled: boolean;
  logOnly: boolean;
  privateKeyBase58: string;
}): void {
  if (config.tradingEnabled && !config.logOnly) parseTradingSigner(config.privateKeyBase58);
}
