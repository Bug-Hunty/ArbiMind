export type SolPriceSource = 'current-quote' | 'fresh-cache' | 'configured-fallback' | 'unavailable';

export interface SolPriceCacheEntry {
  priceUsd: number;
  observedAtMs: number;
}

export interface SolPriceResolution {
  priceUsd: number | null;
  source: SolPriceSource;
  ageMs: number | null;
}

export interface SolPriceResolutionInput {
  currentPriceUsd?: number | null;
  cached?: SolPriceCacheEntry | null;
  configuredFallbackUsd?: number | null;
  nowMs?: number;
  maxCacheAgeMs?: number;
}

function validPrice(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}

/** Resolve SOL/USD without ever converting missing price data into zero. */
export function resolveSolUsdPrice(input: SolPriceResolutionInput): SolPriceResolution {
  const nowMs = input.nowMs ?? Date.now();
  const maxCacheAgeMs = input.maxCacheAgeMs ?? 60_000;

  if (validPrice(input.currentPriceUsd)) {
    return { priceUsd: input.currentPriceUsd, source: 'current-quote', ageMs: 0 };
  }

  if (input.cached && validPrice(input.cached.priceUsd)) {
    const ageMs = nowMs - input.cached.observedAtMs;
    if (ageMs >= 0 && ageMs <= maxCacheAgeMs) {
      return { priceUsd: input.cached.priceUsd, source: 'fresh-cache', ageMs };
    }
  }

  if (validPrice(input.configuredFallbackUsd)) {
    return { priceUsd: input.configuredFallbackUsd, source: 'configured-fallback', ageMs: null };
  }

  return { priceUsd: null, source: 'unavailable', ageMs: null };
}

export class SolPriceResolver {
  private cached: SolPriceCacheEntry | null = null;

  constructor(
    private readonly configuredFallbackUsd: number | null = null,
    private readonly maxCacheAgeMs = 60_000,
  ) {}

  resolve(currentPriceUsd?: number | null, nowMs = Date.now()): SolPriceResolution {
    const resolution = resolveSolUsdPrice({
      currentPriceUsd,
      cached: this.cached,
      configuredFallbackUsd: this.configuredFallbackUsd,
      nowMs,
      maxCacheAgeMs: this.maxCacheAgeMs,
    });
    if (resolution.source === 'current-quote' && resolution.priceUsd !== null) {
      this.cached = { priceUsd: resolution.priceUsd, observedAtMs: nowMs };
    }
    return resolution;
  }

  getCache(): SolPriceCacheEntry | null {
    return this.cached ? { ...this.cached } : null;
  }

  seedCache(priceUsd: number, observedAtMs: number): void {
    this.cached = { priceUsd, observedAtMs };
  }
}
