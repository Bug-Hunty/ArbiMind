/**
 * ShadowReport — log-only performance reporting for Solana shadow runs.
 *
 * Renders a {@link ShadowSnapshot} into a human-readable report and derives a
 * conservative readiness recommendation.
 *
 * This module is pure formatting plus snapshot persistence. It never touches
 * the network, never reads wallet material, and never sends a transaction.
 * Nothing here can enable trading.
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { EconomicObservation, SessionMetrics, ShadowSnapshot } from './SessionMetrics';

// ── Readiness thresholds ───────────────────────────────────────────

/**
 * Minimum evidence required before the report will even consider suggesting a
 * live canary. These are deliberately conservative: the cost of a premature
 * "ready" is real money on a live route, while the cost of an extra day of
 * shadow running is a day.
 */
export const READINESS = {
  /** A run shorter than this cannot characterise a full daily cycle. */
  minWindowHours: 24,
  /** Below this many gate evaluations the pass rate is not a rate, it is noise. */
  minGateEvaluations: 200,
  /** Need to have actually seen the gate let something through. */
  minGatePassed: 10,
  /** Swap building must be reliable before it is trusted to sign. */
  minSwapBuildSuccessRate: 0.95,
  /** Quote failures above this fraction mean the data feed is unreliable. */
  maxQuoteFailureRate: 0.05,
  /** Net expected profit must be positive by a margin, not marginally. */
  minEconomicFloorUsd: 0.02,
  /** A confidence interval is not credible below this usable population. */
  minUsableObservations: 200,
  /** Require observations in at least half of the 24 hourly buckets. */
  minHourlyBuckets: 12,
  maxRpcFailureRate: 0.05,
  maxSnapshotAgeHours: 36,
  /** Compatibility alias; readiness uses the confidence bound instead. */
  minAvgNetEdgeUsd: 0.02,
} as const;

export type ShadowVerdict =
  | 'continue shadow'
  | 'tune thresholds'
  | 'ready for $1 canary'
  | 'not ready';

export interface ShadowRecommendation {
  verdict: ShadowVerdict;
  /** Human-readable justifications, most important first. */
  reasons: string[];
}

// ── Derived rates ──────────────────────────────────────────────────

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function usd(value: number | null): string {
  return value === null ? 'n/a' : `$${value.toFixed(4)}`;
}

function ms(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(0)}ms`;
}

/** Sort a count map descending and take the top N as `label=count` strings. */
function topN(counts: Record<string, number>, n: number): string[] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label, count]) => `${label}=${count}`);
}

export interface EconomicStatistics {
  sampleCount: number;
  mean: number | null;
  median: number | null;
  standardDeviation: number | null;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  confidenceInterval: [number, number] | null;
  lowerConfidenceBound: number | null;
}

function quantile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const position = (values.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (position - lower);
}

/**
 * Deterministic percentile bootstrap for the mean. Resampling the complete
 * ALL-evaluations population avoids treating winners as representative. A
 * fixed LCG makes reports reproducible and keeps tests independent of runtime
 * randomness; the lower percentile is the readiness bound.
 */
export function calculateEconomicStatistics(observations: EconomicObservation[]): EconomicStatistics {
  const values = observations
    .filter((observation) => observation.usable && observation.netExpectedUsd !== null)
    .map((observation) => observation.netExpectedUsd as number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (values.length < READINESS.minUsableObservations) {
    return {
      sampleCount: values.length,
      mean: null,
      median: quantile(values, 0.5),
      standardDeviation: null,
      p10: quantile(values, 0.1),
      p25: quantile(values, 0.25),
      p50: quantile(values, 0.5),
      p75: quantile(values, 0.75),
      p90: quantile(values, 0.9),
      confidenceInterval: null,
      lowerConfidenceBound: null,
    };
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  let state = 0x9e3779b9;
  const bootstrapMeans: number[] = [];
  for (let sample = 0; sample < 2_000; sample++) {
    let total = 0;
    for (let index = 0; index < values.length; index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      total += values[state % values.length];
    }
    bootstrapMeans.push(total / values.length);
  }
  bootstrapMeans.sort((a, b) => a - b);
  return {
    sampleCount: values.length,
    mean,
    median: quantile(values, 0.5),
    standardDeviation: Math.sqrt(variance),
    p10: quantile(values, 0.1),
    p25: quantile(values, 0.25),
    p50: quantile(values, 0.5),
    p75: quantile(values, 0.75),
    p90: quantile(values, 0.9),
    confidenceInterval: [quantile(bootstrapMeans, 0.025)!, quantile(bootstrapMeans, 0.975)!],
    lowerConfidenceBound: quantile(bootstrapMeans, 0.025),
  };
}

function temporalCoverage(snapshot: ShadowSnapshot): { elapsedHours: number; hourlyBuckets: number; largestConcentration: number } {
  const timestamps = snapshot.economicObservations.map((observation) => observation.timestampMs).filter(Number.isFinite);
  if (timestamps.length === 0) return { elapsedHours: 0, hourlyBuckets: 0, largestConcentration: 0 };
  const buckets = new Map<number, number>();
  timestamps.forEach((timestamp) => {
    const bucket = Math.floor(timestamp / 3_600_000);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  });
  return {
    elapsedHours: (Math.max(...timestamps) - Math.min(...timestamps)) / 3_600_000,
    hourlyBuckets: buckets.size,
    largestConcentration: Math.max(...buckets.values()) / timestamps.length,
  };
}

// ── Recommendation ─────────────────────────────────────────────────

/**
 * Derive a readiness verdict from a snapshot.
 *
 * Fails closed. Any missing evidence produces "continue shadow" or
 * "not ready" — never "ready for $1 canary". A recommendation is only as
 * good as the sample behind it, so an under-powered run is explicitly not
 * treated as a passing run.
 */
export function deriveRecommendation(snapshot: ShadowSnapshot): ShadowRecommendation {
  const windowHours = snapshot.sessionDurationSec / 3600;

  const quoteFailureRate = rate(snapshot.quoteFailures, snapshot.quotesRequested);
  const swapBuildSuccessRate = rate(snapshot.swapsBuilt, snapshot.swapBuildsAttempted);
  const gatePassRate = rate(snapshot.gatePassed, snapshot.gateEvaluated);
  const coverage = temporalCoverage(snapshot);
  const statistics = calculateEconomicStatistics(snapshot.economicObservations ?? []);
  const health = snapshot.readinessHealth;

  // --- Hard blockers: something is wrong with the pipeline itself. ---
  const blockers: string[] = [];

  // Contamination check first. A shadow run that submitted anything was not a
  // shadow run, so none of its numbers describe log-only behaviour and no
  // readiness conclusion may be drawn from it. Flagging this in the report body
  // is not enough -- an advisory marker beside a "READY" verdict is exactly the
  // kind of signal that gets read as success.
  if (snapshot.submitted > 0) blockers.push(`shadow run contaminated by ${snapshot.submitted} submitted transaction(s) — SOLANA_LOG_ONLY was not true`);

  // AI scoring blockers. Every opportunity is gated on a score existing, so an
  // unscored run produces zeros through the whole executor funnel. Reporting
  // "no opportunities" for that is the exact failure this check prevents.
  const ai = snapshot.ai;
  if (ai) {
    if (snapshot.aiScoringMode === 'disabled' || snapshot.aiScoringMode === 'unknown') {
      blockers.push(
        `AI scoring mode is "${snapshot.aiScoringMode}" — no opportunity can reach the executor. ` +
          'Set AI_SCORING_MODE=local (or configure AI_PREDICT_URL) before drawing conclusions.',
      );
    }
    if (ai.requested > 0 && ai.returned === 0) {
      const detail = ai.missing > 0 ? `${ai.missing} missing` : `${ai.errored} errored`;
      blockers.push(
        `AI scorer answered 0 of ${ai.requested} requests (${detail}) — the funnel never started, ` +
          'so zero opportunities does not mean a quiet market',
      );
    }
  }

  if (snapshot.quotesRequested === 0) blockers.push('no quotes were requested — scanner never reached the quote stage');
  if (quoteFailureRate !== null && quoteFailureRate > READINESS.maxQuoteFailureRate) {
    blockers.push(
      `quote failure rate ${pct(quoteFailureRate)} exceeds ${pct(READINESS.maxQuoteFailureRate)} — data feed unreliable`,
    );
  }
  if (
    swapBuildSuccessRate !== null &&
    snapshot.swapBuildsAttempted > 0 &&
    swapBuildSuccessRate < READINESS.minSwapBuildSuccessRate
  ) {
    blockers.push(
      `swap build success rate ${pct(swapBuildSuccessRate)} below ${pct(READINESS.minSwapBuildSuccessRate)}`,
    );
  }
  const rpcRate = rate(snapshot.rpc.errors + snapshot.rpc.rateLimited + snapshot.rpc.latencyFailures, snapshot.quotesRequested);
  if (rpcRate === null || rpcRate > READINESS.maxRpcFailureRate) blockers.push(`RPC failure/rate limiting rate ${pct(rpcRate)} is unavailable or exceeds ${pct(READINESS.maxRpcFailureRate)}`);
  if (health === undefined) blockers.push('readiness health is absent (legacy snapshot)');
  else {
    const fee = health.feeEstimation;
    const feeRate = rate(fee.unavailable, fee.attempted);
    // Naming the two cases apart matters: "never ran" and "ran and failed too
    // often" are both blocking, but only one of them is evidence about the
    // estimator. A run with no market opportunity produces the first.
    if (fee.state === 'NOT_EXERCISED' || feeRate === null) {
      blockers.push(
        `fee estimation was never exercised (attempted=${fee.attempted}) — its health is unknown, not healthy`,
      );
    } else if (feeRate > 0.05) {
      blockers.push(`fee estimation unavailable rate ${pct(feeRate)} exceeds 5%`);
    }
    if (health.poolResolution.configured <= 0 || health.poolResolution.unresolved > 0) blockers.push('configured pools are unresolved');
    if (health.observationPersistence.attempted <= 0 || health.observationPersistence.failed > 0) blockers.push('observation persistence is not healthy');
    // A snapshot taken during a build (or with a lost terminal event) cannot
    // establish health. The serialized "attempted" count means requested.
    if (health.simulation.attempted <= 0 || health.simulation.attempted !== health.simulation.succeeded + health.simulation.failed) blockers.push('build/simulation attempts have missing terminal results');
    if (health.simulation.failed > 0) blockers.push('quote/build/simulation failures were recorded');
    if (health.sourceSha === null || health.runtimeSha === null || health.sourceSha !== health.runtimeSha) blockers.push('runtime/source SHA provenance is missing or mismatched');
    if (health.requiredSafetyConfiguration !== true) blockers.push('required safety configuration is missing or invalid');
  }

  if (blockers.length > 0) {
    return { verdict: 'not ready', reasons: blockers };
  }

  if (windowHours < READINESS.minWindowHours) blockers.push(`window ${windowHours.toFixed(1)}h is under the ${READINESS.minWindowHours}h minimum`);
  if (statistics.sampleCount < READINESS.minUsableObservations) blockers.push(`only ${statistics.sampleCount} usable observations (need ${READINESS.minUsableObservations})`);
  if (coverage.elapsedHours < READINESS.minWindowHours || coverage.hourlyBuckets < READINESS.minHourlyBuckets) blockers.push(`time coverage is insufficient: ${coverage.hourlyBuckets} hourly buckets across ${coverage.elapsedHours.toFixed(1)}h`);
  const capturedAgeHours = (Date.now() - Date.parse(snapshot.capturedAtIso)) / 3_600_000;
  if (!Number.isFinite(capturedAgeHours) || capturedAgeHours < 0 || capturedAgeHours > READINESS.maxSnapshotAgeHours) blockers.push('snapshot is stale or has an invalid capture time');
  if (blockers.length > 0) return { verdict: 'not ready', reasons: blockers };

  // --- Enough evidence: is the economics actually favourable? ---
  if (snapshot.gatePassed < READINESS.minGatePassed) {
    return {
      verdict: 'tune thresholds',
      reasons: [
        `gate passed only ${snapshot.gatePassed} times in ${snapshot.gateEvaluated} evaluations (${pct(gatePassRate)})`,
        `top reject reasons: ${topN(snapshot.rejectReasons, 3).join(', ') || 'none recorded'}`,
        'thresholds are rejecting effectively everything — either the market lacks edge or the gate is too strict',
      ],
    };
  }
  if (statistics.lowerConfidenceBound === null || statistics.lowerConfidenceBound < READINESS.minEconomicFloorUsd) {
    return {
      verdict: 'tune thresholds',
      reasons: [
        `lower 95% confidence bound ${usd(statistics.lowerConfidenceBound)} does not clear ${usd(READINESS.minEconomicFloorUsd)}`,
        `all-evaluation mean is ${usd(statistics.mean)}; point estimate alone cannot establish readiness`,
      ],
    };
  }

  return {
    verdict: 'ready for $1 canary',
    reasons: [
      `${windowHours.toFixed(1)}h window with ${statistics.sampleCount} usable observations across ${coverage.hourlyBuckets} hourly buckets`,
      `gate pass rate ${pct(gatePassRate)} (${snapshot.gatePassed} passed)`,
      `swap build success ${pct(swapBuildSuccessRate)}`,
      `all-evaluation mean ${usd(statistics.mean)} with lower 95% bound ${usd(statistics.lowerConfidenceBound)}`,
      'shadow evidence supports a manually-reviewed $1 canary — this is a recommendation, not an authorisation',
    ],
  };
}

// ── Report rendering ───────────────────────────────────────────────

/**
 * Render a snapshot as the shadow performance report.
 *
 * Output contains only aggregates and venue labels. No signatures, wallet
 * addresses, RPC URLs or API keys pass through here.
 */
export function renderShadowReport(snapshot: ShadowSnapshot): string {
  const windowHours = snapshot.sessionDurationSec / 3600;
  const quoteFailureRate = rate(snapshot.quoteFailures, snapshot.quotesRequested);
  const swapBuildSuccessRate = rate(snapshot.swapsBuilt, snapshot.swapBuildsAttempted);
  const gatePassRate = rate(snapshot.gatePassed, snapshot.gateEvaluated);
  const recommendation = deriveRecommendation(snapshot);

  const lines: string[] = [];
  const push = (label: string, value: string): void => {
    lines.push(`  ${label.padEnd(26)}${value}`);
  };

  lines.push('SHADOW PERFORMANCE REPORT');
  lines.push('='.repeat(60));
  lines.push('');

  lines.push('window:');
  push('start', snapshot.startedAtIso);
  push('captured', snapshot.capturedAtIso);
  push('duration', `${windowHours.toFixed(2)}h`);
  lines.push('');

  lines.push('AI scoring:');
  push('mode', snapshot.aiScoringMode ?? 'unknown');
  if (snapshot.ai) {
    push('requested', String(snapshot.ai.requested));
    push('returned', String(snapshot.ai.returned));
    push('actionable', String(snapshot.ai.actionable));
    push('missing', String(snapshot.ai.missing));
    push('below confidence', String(snapshot.ai.belowConfidence));
    push('errored', String(snapshot.ai.errored));
    if (snapshot.ai.requested > 0 && snapshot.ai.returned === 0) {
      lines.push('  ^ scorer never answered — the executor funnel below never started');
    }
  }
  // Stated plainly because the numbers invite the opposite reading: the
  // scanner's execute decision comes from net edge, not from this score.
  lines.push('  note: scorer verdict is observational — execution is gated on net edge,');
  lines.push('        and a score is currently required only to be present, not favourable');
  lines.push('');

  lines.push('opportunities:');
  push('detected', String(snapshot.discovered));
  push('skipped (pre-gate)', String(snapshot.skipped));
  lines.push('');

  lines.push('quotes:');
  push('requested', String(snapshot.quotesRequested));
  push('failed', `${snapshot.quoteFailures} (${pct(quoteFailureRate)})`);
  push('avg age', ms(snapshot.avgQuoteAgeMs));
  lines.push('');

  lines.push('swap builds:');
  push('attempted', String(snapshot.swapBuildsAttempted));
  push('succeeded', String(snapshot.swapsBuilt));
  push('failed', String(snapshot.swapBuildFailed));
  push('success rate', pct(swapBuildSuccessRate));
  lines.push('');

  // Fee estimation leans on two independent inputs, and a run can produce
  // estimates all day on fallback values. Printing the state and the source
  // split keeps "no errors" from reading as "live pricing".
  const feeHealth = snapshot.readinessHealth?.feeEstimation;
  if (feeHealth) {
    lines.push('fee estimation:');
    push('state', feeHealth.state ?? '(not recorded — legacy snapshot)');
    push('attempted', String(feeHealth.attempted));
    push('available', String(feeHealth.available));
    push('unavailable', String(feeHealth.unavailable));
    if (feeHealth.fallbackAttempts !== undefined) {
      push('fallback attempts', `${feeHealth.fallbackAttempts} (${pct(feeHealth.fallbackRate ?? null)})`);
    }
    // A legacy snapshot predates these counters; render it as absent rather
    // than throwing on the report path.
    const split = (counts: Record<string, number> | undefined): string[] =>
      Object.entries(counts ?? {})
        .filter(([, count]) => count > 0)
        .map(([label, count]) => `${label}=${count}`);
    const priceSplit = split(feeHealth.priceSources);
    const feeSplit = split(feeHealth.feeSources);
    push('sol price source', priceSplit.join(', ') || '(none recorded)');
    push('priority fee source', feeSplit.join(', ') || '(none recorded)');
    if (feeHealth.state === 'NOT_EXERCISED') {
      lines.push('  ^ never exercised — this is unknown, not healthy');
    }
    lines.push('');
  }

  lines.push('gate pass rate:');
  push('evaluated', String(snapshot.gateEvaluated));
  push('passed', String(snapshot.gatePassed));
  push('rejected', String(snapshot.gateRejected));
  push('pass rate', pct(gatePassRate));
  lines.push('');

  lines.push('top reject reasons:');
  const rejects = topN(snapshot.rejectReasons, 5);
  if (rejects.length === 0) lines.push('  (none recorded)');
  else rejects.forEach((r) => lines.push(`  ${r}`));
  lines.push('');

  lines.push('top pre-gate skips:');
  const skips = topN(snapshot.skipReasons, 5);
  if (skips.length === 0) lines.push('  (none recorded)');
  else skips.forEach((r) => lines.push(`  ${r}`));
  lines.push('');

  lines.push('top AMMs:');
  const amms = topN(snapshot.ammLabels, 5);
  if (amms.length === 0) lines.push('  (none recorded)');
  else amms.forEach((r) => lines.push(`  ${r}`));
  lines.push('');

  lines.push('route types:');
  const routes = topN(snapshot.routeTypes, 5);
  if (routes.length === 0) lines.push('  (none recorded)');
  else routes.forEach((r) => lines.push(`  ${r}`));
  lines.push('');

  lines.push('latency:');
  push('quote avg', ms(snapshot.quoteLatency.avgMs));
  push('quote max', ms(snapshot.quoteLatency.maxMs));
  push('swap build avg', ms(snapshot.swapBuildLatency.avgMs));
  push('swap build max', ms(snapshot.swapBuildLatency.maxMs));
  lines.push('');

  lines.push('expected economics:');
  push('avg gross profit', usd(snapshot.avgExpectedGrossUsd));
  push('avg execution fee', usd(snapshot.avgExecutionFeeUsd));
  push('avg slippage cost', usd(snapshot.avgSlippageCostUsd));
  push('avg net profit', usd(snapshot.avgNetEdgeUsd));
  push('avg edge bps', snapshot.avgNetEdgeBpsOfNotional === null ? 'n/a' : `${snapshot.avgNetEdgeBpsOfNotional}`);
  push('best gross seen', usd(snapshot.bestGrossOverallUsd));
  lines.push('  note: computed at gate evaluation across every evaluation (pass + reject) —');
  lines.push('        these are estimates, not realized PnL, and populate in log-only mode');
  lines.push('');

  const coverage = temporalCoverage(snapshot);
  const statistics = calculateEconomicStatistics(snapshot.economicObservations ?? []);
  lines.push('STATISTICAL READINESS:');
  push('duration:', `${windowHours.toFixed(2)}h`);
  push('observation count:', String(snapshot.economicObservations?.length ?? 0));
  push('usable observation count:', String(statistics.sampleCount));
  push('hourly coverage:', `${coverage.hourlyBuckets} buckets / ${coverage.elapsedHours.toFixed(2)}h`);
  push('largest concentration:', pct(coverage.largestConcentration));
  push('confidence method:', 'deterministic percentile bootstrap (95%)');
  push('mean net edge (ALL):', usd(statistics.mean));
  push('median net edge:', usd(statistics.median));
  push('p10 / p90:', `${usd(statistics.p10)} / ${usd(statistics.p90)}`);
  push('95% CI:', statistics.confidenceInterval ? `${usd(statistics.confidenceInterval[0])} to ${usd(statistics.confidenceInterval[1])}` : 'n/a');
  push('lower confidence bound:', usd(statistics.lowerConfidenceBound));
  push('required floor:', usd(READINESS.minEconomicFloorUsd));
  lines.push('  infrastructure blockers: reported by readiness health');
  lines.push('  economic blockers: lower confidence bound must clear required floor');
  lines.push('  data-quality blockers: usable observations and temporal coverage are required');
  lines.push('');

  lines.push('realized economics (confirmed live submissions only):');
  if (snapshot.realizedTradeCount > 0) {
    push('trades confirmed', String(snapshot.realizedTradeCount));
    push('avg gross profit', usd(snapshot.avgRealizedGrossUsd));
    push('avg execution fee', usd(snapshot.avgRealizedExecutionFeeUsd));
    push('avg net profit', usd(snapshot.avgRealizedNetEdgeUsd));
  } else {
    lines.push('  (no confirmed trades — expected and correct for a log-only run)');
  }
  lines.push('');

  lines.push('risk notes:');
  push('rpc errors', String(snapshot.rpc.errors));
  push('rpc rate-limited (429)', String(snapshot.rpc.rateLimited));
  push('rpc latency failures', String(snapshot.rpc.latencyFailures));
  // Submitted must be zero for a log-only run. Surfacing it makes a
  // misconfigured run obvious in the report itself rather than only in logs.
  push('transactions submitted', `${snapshot.submitted}${snapshot.submitted > 0 ? '  <-- NOT LOG-ONLY' : ''}`);
  lines.push('');

  lines.push('recommendation:');
  const displayedVerdict = recommendation.verdict === 'ready for $1 canary'
    ? 'READY FOR MANUAL CANARY REVIEW'
    : recommendation.verdict.toUpperCase();
  lines.push(`  ${displayedVerdict}`);
  recommendation.reasons.forEach((r) => lines.push(`    - ${r}`));
  lines.push('');

  return lines.join('\n');
}

// ── Snapshot persistence ───────────────────────────────────────────

/**
 * Periodically writes a shadow snapshot to disk so a 24–72h run can be
 * reported on while still in progress, or after the process has exited.
 *
 * Opt-in: nothing starts unless an explicit path is supplied. Writes are
 * atomic (temp file + rename) so the report script can never observe a
 * half-written JSON document.
 */
export class ShadowSnapshotWriter {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly metrics: SessionMetrics,
    private readonly filePath: string,
    private readonly intervalMs: number = 60_000,
  ) {}

  async writeOnce(): Promise<void> {
    try {
      const snapshot = this.metrics.getShadowSnapshot();
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
      await fs.rename(tmp, this.filePath);
      this.metrics.recordObservationPersistence(true);
    } catch (error) {
      this.metrics.recordObservationPersistence(false);
      throw error;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // A failed snapshot write must never interrupt the trading loop: the
      // report is observability, not a dependency of execution.
      void this.writeOnce().catch(() => undefined);
    }, this.intervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** Read a snapshot written by {@link ShadowSnapshotWriter}. */
export async function readShadowSnapshot(filePath: string): Promise<ShadowSnapshot> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as ShadowSnapshot;
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `unsupported shadow snapshot schemaVersion ${String(parsed.schemaVersion)} (expected 1)`,
    );
  }
  return parsed;
}
