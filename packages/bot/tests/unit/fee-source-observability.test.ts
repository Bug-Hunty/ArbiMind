/**
 * Fee-source observability.
 *
 * A fee estimate is built from two independent provenances -- the SOL/USD
 * price and the priority-fee estimate -- and for a long time only the first
 * was recorded, under a name that read like the second. A run could therefore
 * price every trade off a configured fallback and still report "fee
 * estimation: 0 unavailable", which is how "no errors" came to be mistaken
 * for "live pricing".
 *
 * These tests pin the distinction: every canonical label is counted on its own
 * axis, fallback is visible as fallback, and an estimator that never ran is
 * NOT_EXERCISED rather than healthy.
 */

import { describe, it, expect } from 'vitest';
import {
  SessionMetrics,
  deriveFeeEstimationState,
  emptyFeeEstimationHealth,
  PRIORITY_FEE_SOURCES,
  SOL_PRICE_SOURCES,
} from '../../src/solana/SessionMetrics';
import type { ShadowSnapshot } from '../../src/solana/SessionMetrics';
import { deriveRecommendation } from '../../src/solana/ShadowReport';

function feeHealthOf(metrics: SessionMetrics) {
  return metrics.getShadowSnapshot().readinessHealth.feeEstimation;
}

describe('fee-source observability', () => {
  describe('source taxonomy', () => {
    it('counts each canonical SOL price source on its own axis', () => {
      for (const source of SOL_PRICE_SOURCES) {
        const metrics = new SessionMetrics();
        // `unavailable` is the one label that cannot have produced an estimate.
        metrics.recordFeeEstimation(source !== 'unavailable', { source });

        const fee = feeHealthOf(metrics);
        expect(fee.priceSources[source]).toBe(1);
        expect(fee.attempted).toBe(1);
        // No other label was touched.
        expect(Object.values(fee.priceSources).reduce((a, b) => a + b, 0)).toBe(1);
      }
    });

    it('counts each canonical priority-fee source on its own axis', () => {
      for (const feeSource of PRIORITY_FEE_SOURCES) {
        const metrics = new SessionMetrics();
        metrics.recordFeeEstimation(true, { source: 'current-quote', feeSource });

        const fee = feeHealthOf(metrics);
        expect(fee.feeSources[feeSource]).toBe(1);
        expect(Object.values(fee.feeSources).reduce((a, b) => a + b, 0)).toBe(1);
        // The price axis is recorded independently, not overwritten.
        expect(fee.priceSources['current-quote']).toBe(1);
      }
    });

    it('does not let an unknown label silently increment a counter', () => {
      const metrics = new SessionMetrics();
      metrics.recordFeeEstimation(true, { source: 'made-up', feeSource: 'also-made-up' });

      const fee = feeHealthOf(metrics);
      expect(fee.attempted).toBe(1);
      expect(Object.values(fee.priceSources).reduce((a, b) => a + b, 0)).toBe(0);
      expect(Object.values(fee.feeSources).reduce((a, b) => a + b, 0)).toBe(0);
    });
  });

  describe('state', () => {
    it('reports NOT_EXERCISED, never HEALTHY, when nothing was attempted', () => {
      const fee = feeHealthOf(new SessionMetrics());

      expect(fee.attempted).toBe(0);
      expect(fee.available).toBe(0);
      expect(fee.unavailable).toBe(0);
      expect(fee.state).toBe('NOT_EXERCISED');
      expect(fee.fallbackRate).toBeNull();
      // The exact shape the old readiness record had, now carrying a verdict.
      expect(emptyFeeEstimationHealth().state).toBe('NOT_EXERCISED');
    });

    it('reports HEALTHY only when every attempt used live inputs', () => {
      const metrics = new SessionMetrics();
      metrics.recordFeeEstimation(true, { source: 'current-quote', feeSource: 'dynamic_global' });
      metrics.recordFeeEstimation(true, {
        source: 'current-quote',
        feeSource: 'dynamic_account_specific',
      });

      const fee = feeHealthOf(metrics);
      expect(fee.state).toBe('HEALTHY');
      expect(fee.fallbackAttempts).toBe(0);
      expect(fee.fallbackRate).toBe(0);
    });

    it('a fallback-only sample is DEGRADED_FALLBACK, not healthy or current', () => {
      const metrics = new SessionMetrics();
      for (let i = 0; i < 4; i++) {
        metrics.recordFeeEstimation(true, {
          source: 'configured-fallback',
          feeSource: 'static-fallback',
        });
      }

      const fee = feeHealthOf(metrics);
      // Every attempt "succeeded", so an errors-only view calls this healthy.
      expect(fee.available).toBe(4);
      expect(fee.unavailable).toBe(0);
      // It is not.
      expect(fee.state).toBe('DEGRADED_FALLBACK');
      expect(fee.fallbackAttempts).toBe(4);
      expect(fee.fallbackRate).toBe(1);
      expect(fee.priceSources['current-quote']).toBe(0);
    });

    it('counts an attempt that fell back on both axes only once', () => {
      const metrics = new SessionMetrics();
      metrics.recordFeeEstimation(true, {
        source: 'configured-fallback',
        feeSource: 'static-fallback',
      });

      expect(feeHealthOf(metrics).fallbackAttempts).toBe(1);
    });

    it('treats fresh-cache as non-fallback but still not current', () => {
      const metrics = new SessionMetrics();
      metrics.recordFeeEstimation(true, { source: 'fresh-cache', feeSource: 'cached' });

      const fee = feeHealthOf(metrics);
      expect(fee.fallbackAttempts).toBe(0);
      expect(fee.state).toBe('HEALTHY');
      expect(fee.priceSources['fresh-cache']).toBe(1);
      expect(fee.priceSources['current-quote']).toBe(0);
    });

    it('UNAVAILABLE outranks fallback when any attempt produced nothing', () => {
      const metrics = new SessionMetrics();
      metrics.recordFeeEstimation(true, { source: 'configured-fallback' });
      metrics.recordFeeEstimation(false, { source: 'unavailable' });

      const fee = feeHealthOf(metrics);
      expect(fee.unavailable).toBe(1);
      expect(fee.state).toBe('UNAVAILABLE');
      expect(fee.priceSources['unavailable']).toBe(1);
    });

    it('orders states so absence of measurement outranks every other claim', () => {
      expect(deriveFeeEstimationState({ attempted: 0, unavailable: 5, fallbackAttempts: 5 }))
        .toBe('NOT_EXERCISED');
      expect(deriveFeeEstimationState({ attempted: 5, unavailable: 1, fallbackAttempts: 5 }))
        .toBe('UNAVAILABLE');
      expect(deriveFeeEstimationState({ attempted: 5, unavailable: 0, fallbackAttempts: 1 }))
        .toBe('DEGRADED_FALLBACK');
      expect(deriveFeeEstimationState({ attempted: 5, unavailable: 0, fallbackAttempts: 0 }))
        .toBe('HEALTHY');
    });
  });

  describe('mixed distribution', () => {
    it('keeps a per-label distribution across a mixed sample', () => {
      const metrics = new SessionMetrics();
      const plan: Array<[string, string, boolean]> = [
        ['current-quote', 'dynamic_global', true],
        ['current-quote', 'dynamic_global', true],
        ['current-quote', 'cached', true],
        ['fresh-cache', 'cached', true],
        ['configured-fallback', 'static-fallback', true],
        ['unavailable', 'static-fallback', false],
      ];
      for (const [source, feeSource, available] of plan) {
        metrics.recordFeeEstimation(available, { source, feeSource });
      }

      const fee = feeHealthOf(metrics);
      expect(fee.attempted).toBe(6);
      expect(fee.available).toBe(5);
      expect(fee.unavailable).toBe(1);
      expect(fee.priceSources).toEqual({
        'current-quote': 3,
        'fresh-cache': 1,
        'configured-fallback': 1,
        unavailable: 1,
      });
      expect(fee.feeSources).toEqual({
        dynamic_account_specific: 0,
        dynamic_global: 2,
        cached: 2,
        'static-fallback': 2,
      });
      // Two attempts leaned on a fallback on at least one axis.
      expect(fee.fallbackAttempts).toBe(2);
      expect(fee.fallbackRate).toBeCloseTo(2 / 6);
    });

    it('does not let a later attempt mutate an already-issued snapshot', () => {
      const metrics = new SessionMetrics();
      metrics.recordFeeEstimation(true, { source: 'current-quote', feeSource: 'dynamic_global' });
      const before = feeHealthOf(metrics);

      metrics.recordFeeEstimation(true, {
        source: 'configured-fallback',
        feeSource: 'static-fallback',
      });

      expect(before.priceSources['configured-fallback']).toBe(0);
      expect(before.feeSources['static-fallback']).toBe(0);
      expect(before.fallbackAttempts).toBe(0);
    });
  });

  describe('readiness', () => {
    function snapshotWith(feeEstimation: Partial<ShadowSnapshot['readinessHealth']['feeEstimation']>): ShadowSnapshot {
      const base = new SessionMetrics().getShadowSnapshot();
      const now = Date.now();
      return {
        ...base,
        sessionDurationSec: 30 * 3600,
        discovered: 5_000,
        skipped: 4_000,
        quotesRequested: 1_000,
        quoteFailures: 5,
        swapBuildsAttempted: 100,
        swapsBuilt: 100,
        swapBuildFailed: 0,
        gateEvaluated: 500,
        gatePassed: 100,
        gateRejected: 400,
        avgNetEdgeUsd: 0.15,
        submitted: 0,
        aiScoringMode: 'local',
        ai: {
          requested: 1_000,
          returned: 1_000,
          missing: 0,
          errored: 0,
          actionable: 400,
          belowConfidence: 600,
        },
        economicObservations: Array.from({ length: 500 }, (_, index) => ({
          timestampMs: now - 25 * 60 * 60 * 1000 + index * ((25 * 60 * 60 * 1000) / 499),
          netExpectedUsd: 0.15,
          usable: true,
          passed: index < 100,
        })),
        capturedAtIso: new Date(now).toISOString(),
        readinessHealth: {
          ...base.readinessHealth,
          feeEstimation: { ...emptyFeeEstimationHealth(), ...feeEstimation },
          poolResolution: { configured: 5, resolved: 5, unresolved: 0 },
          observationPersistence: { attempted: 500, succeeded: 500, failed: 0 },
          simulation: { attempted: 100, succeeded: 100, failed: 0 },
          sourceSha: 'test-sha',
          runtimeSha: 'test-sha',
          requiredSafetyConfiguration: true,
        },
      };
    }

    it('blocks on a never-exercised estimator and says so in those terms', () => {
      const result = deriveRecommendation(snapshotWith({}));

      expect(result.verdict).toBe('not ready');
      expect(result.reasons.some((reason) => /never exercised/i.test(reason))).toBe(true);
      // It must not be described as a tolerance breach -- nothing was measured.
      expect(result.reasons.some((reason) => /exceeds 5%/.test(reason))).toBe(false);
    });

    it('fails closed when estimates were unavailable beyond tolerance', () => {
      const result = deriveRecommendation(
        snapshotWith({
          attempted: 500,
          available: 400,
          unavailable: 100,
          state: 'UNAVAILABLE',
          priceSources: { 'current-quote': 400, 'fresh-cache': 0, 'configured-fallback': 0, unavailable: 100 },
        }),
      );

      expect(result.verdict).toBe('not ready');
      expect(result.reasons.some((reason) => /exceeds 5%/.test(reason))).toBe(true);
    });

    it('does not manufacture a red run purely because fallback was used', () => {
      const result = deriveRecommendation(
        snapshotWith({
          attempted: 500,
          available: 500,
          unavailable: 0,
          state: 'DEGRADED_FALLBACK',
          fallbackAttempts: 500,
          fallbackRate: 1,
          priceSources: { 'current-quote': 0, 'fresh-cache': 0, 'configured-fallback': 500, unavailable: 0 },
          feeSources: { dynamic_account_specific: 0, dynamic_global: 0, cached: 0, 'static-fallback': 500 },
        }),
      );

      // Existing policy does not blocklist fallback, so the verdict must not
      // invent one -- but the degradation is still recorded and reportable.
      expect(result.reasons.some((reason) => /fee estimation/i.test(reason))).toBe(false);
    });
  });
});
