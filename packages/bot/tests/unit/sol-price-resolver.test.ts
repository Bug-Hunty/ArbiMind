import { describe, expect, it } from 'vitest';
import { resolveSolUsdPrice } from '../../src/solana/SolPriceResolver';

describe('SOL/USD source matrix', () => {
  it('prefers the current quote', () => {
    expect(resolveSolUsdPrice({ currentPriceUsd: 150, configuredFallbackUsd: 100 })).toMatchObject({
      priceUsd: 150,
      source: 'current-quote',
      ageMs: 0,
    });
  });

  it('uses a fresh cache when the current quote is unavailable', () => {
    expect(resolveSolUsdPrice({
      cached: { priceUsd: 145, observedAtMs: 90_000 },
      nowMs: 100_000,
      maxCacheAgeMs: 20_000,
      configuredFallbackUsd: 100,
    })).toMatchObject({ priceUsd: 145, source: 'fresh-cache', ageMs: 10_000 });
  });

  it('rejects stale cache before using a configured fallback', () => {
    expect(resolveSolUsdPrice({
      cached: { priceUsd: 145, observedAtMs: 1 },
      nowMs: 100_000,
      maxCacheAgeMs: 20_000,
      configuredFallbackUsd: 100,
    })).toMatchObject({ priceUsd: 100, source: 'configured-fallback', ageMs: null });
  });

  it('returns unavailable when every source is invalid', () => {
    expect(resolveSolUsdPrice({ currentPriceUsd: 0, configuredFallbackUsd: null })).toEqual({
      priceUsd: null,
      source: 'unavailable',
      ageMs: null,
    });
  });
});
