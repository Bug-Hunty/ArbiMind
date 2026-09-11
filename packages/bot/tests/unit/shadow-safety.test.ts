/**
 * Shadow-mode safety tests.
 *
 * These assert the guarantees that make a 24–72h shadow run safe to leave
 * unattended. The central one is that with SOLANA_LOG_ONLY=true the executor
 * builds a swap transaction and then stops — it must never reach
 * connection.sendTransaction.
 *
 * No secret material is embedded here: the signer is generated at runtime, so
 * there is no key-shaped literal in the repository.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

// ── Solana web3 stub ───────────────────────────────────────────────
// Connection and VersionedTransaction are replaced; Keypair/PublicKey stay
// real so signer loading exercises the production code path.

// vi.mock is hoisted above ordinary declarations, so anything the factory
// touches must come from vi.hoisted or be defined inside the factory itself.
const { sendTransaction, confirmTransaction, getLatestBlockhash, signedTransaction } = vi.hoisted(
  () => ({
    sendTransaction: vi.fn(),
    confirmTransaction: vi.fn(),
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 1_000,
    }),
    signedTransaction: {
      sign: vi.fn(),
      serialize: vi.fn(() => new Uint8Array([1, 2, 3])),
      message: {
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 1,
        },
        staticAccountKeys: [],
        compiledInstructions: [],
      },
    },
  }),
);

const journalFiles = vi.hoisted(() => ({ roots: new Set<string>(), files: new Map<string, Buffer>() }));
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const { journalFilesystem } = await import('../mocks/journal-filesystem');
  return journalFilesystem(actual, journalFiles);
});

/**
 * Silence the winston logger for this file.
 *
 * The readiness-reachability test below drives the executor through 200+ gate
 * evaluations, each emitting several structured log lines. Left unsilenced that
 * floods vitest's console-log RPC (observed: `EnvironmentTeardownError: Closing
 * rpc while "onUserConsoleLog" was pending`) and loads the run enough to trip
 * unrelated env-sensitive tests in other files. A test must not destabilise the
 * suite it runs in.
 */
vi.mock('../../src/utils/Logger', () => ({
  Logger: class {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
  },
}));

vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual<typeof import('@solana/web3.js')>('@solana/web3.js');
  // Declared inside the factory: the executor calls `new Connection(...)`, so
  // this must be constructible — an arrow function is not.
  class MockConnection {
    sendTransaction = sendTransaction;
    confirmTransaction = confirmTransaction;
    getLatestBlockhash = getLatestBlockhash;
    getBalance = vi.fn().mockResolvedValue(1_000_000_000);
    getTokenAccountsByOwner = vi.fn().mockResolvedValue({ value: [] });
    getRecentPrioritizationFees = vi.fn().mockResolvedValue([]);
    getParsedTokenAccountsByOwner = vi.fn().mockResolvedValue({ value: [] });
  }
  return {
    ...actual,
    Connection: MockConnection,
    VersionedTransaction: {
      deserialize: vi.fn(() => signedTransaction),
    },
  };
});

import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { SolanaExecutor, classifyQuoteError } from '../../src/solana/Executor';
import type { SolanaExecutorConfig, SwapOpportunity } from '../../src/solana/Executor';
import { SessionMetrics } from '../../src/solana/SessionMetrics';
import { calculateEconomicStatistics, deriveRecommendation, READINESS } from '../../src/solana/ShadowReport';
import { EconomicsJournal } from '../../src/solana/EconomicsJournal';
import { SolPriceResolver } from '../../src/solana/SolPriceResolver';
import { publishPoolResolution, publishRuntimeProvenance, publishSafetyConfiguration } from '../../src/solana/ReadinessProducers';

// ── Fixtures ───────────────────────────────────────────────────────

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Generated per run — never a literal secret in the repo. */
function generateSignerBase58(): string {
  return bs58.encode(Keypair.generate().secretKey);
}

function makeConfig(overrides: Partial<SolanaExecutorConfig> = {}): SolanaExecutorConfig {
  return {
    tradingEnabled: true,
    logOnly: true,
    canaryMode: true,
    onlyDirectRoutes: true,
    allowMultihop: false,
    computeUnitLimit: 200_000,
    priorityFeeMicroLamports: 1_000,
    maxPriceImpactPct: 5,
    ammDenylist: [],
    ammAllowlist: [],
    templateDenylist: [],
    raydiumFingerprintDenylist: [],
    asLegacyTransaction: false,
    tradeSizeMode: 'fixed',
    minSpreadBps: 10,
    allocationPct: 0.5,
    minTradeSizeUsd: 1,
    maxTradeSizeUsd: 5,
    drawdownTriggerPct: 0,
    drawdownScale: 1,
    maxNotionalUsd: 5,
    minNotionalUsd: 0,
    minExpectedProfitUsd: 0.1,
    maxDailyLossUsd: 5,
    stopLossPct: 0,
    takeProfitPct: 0,
    maxSlippageBps: 50,
    quoteMaxAgeMs: 10_000,
    solPriceUsd: 150,
    rpcUrl: 'http://localhost:8899',
    privateKeyBase58: generateSignerBase58(),
    jupiterBaseUrl: 'https://jupiter.invalid',
    riskPolicy: {
      denyTiers: ['critical'],
      canaryTiers: [],
      canaryMaxNotionalUsd: 5,
      minEdgeBumpBps: 0,
      incidentCooldownDays: 0,
      denyIncidentTypes: [],
    },
    ...overrides,
  };
}

/** Gate config that passes freely, so gate behaviour is isolated per-test. */
const PERMISSIVE_GATE = {
  minNetProfitUsd: 0,
  riskBufferUsd: 0,
  slippageFallbackUsd: 0,
  slippageDiscountFactor: 0,
  executionHaircutUsd: 0,
  minEdgeBps: 0,
};

function makeOpportunity(overrides: Partial<SwapOpportunity> = {}): SwapOpportunity {
  return {
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    amountLamports: 10_000_000,
    estimatedNotionalUsd: 3,
    expectedProfitUsd: 1,
    spreadBps: 100,
    label: 'SOL/USDC',
    ...overrides,
  };
}

/** Jupiter quote + swap responses, routed by URL. */
type MockResponse = Pick<Response, 'ok' | 'status' | 'json'> & Partial<Pick<Response, 'text'>>;

function installFetchMock(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown): Promise<MockResponse> => {
    const url = String(input);
    if (url.includes('/quote')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          outAmount: '3050000',
          otherAmountThreshold: '3040000',
          priceImpactPct: '0.01',
          inputMint: SOL_MINT,
          outputMint: USDC_MINT,
          inAmount: '10000000',
          routePlan: [
            { percent: 100, swapInfo: { ammKey: 'pool1', label: 'Whirlpool', inputMint: SOL_MINT, outputMint: USDC_MINT } },
          ],
        }),
      };
    }
    if (url.includes('/swap')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ swapTransaction: Buffer.from('fake-tx').toString('base64') }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const readinessDirectories: string[] = [];

function readinessMetrics(clock?: () => number): { metrics: SessionMetrics; journalPath: string } {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'arbimind-readiness-'));
  readinessDirectories.push(directory);
  journalFiles.roots.add(directory);
  const journalPath = path.join(directory, 'economics.jsonl');
  return { metrics: new SessionMetrics({ clock, economicsJournalPath: journalPath }), journalPath };
}

/** Input events traverse the real executor, producers, journal and snapshot. */
async function healthyReadinessFixture() {
  const fetchMock = installFetchMock();
  const end = Date.now();
  const start = end - 30 * 3_600_000;
  let now = start;
  const { metrics, journalPath } = readinessMetrics(() => now);
  metrics.setAiScoringMode('local');
  publishRuntimeProvenance(metrics, {
    sourceSha: 'test-sha', runtimeSha: 'test-sha', nodeVersion: process.version,
    startedAtIso: new Date(start).toISOString(), buildAtIso: new Date(start).toISOString(),
  });
  publishSafetyConfiguration(metrics, true);
  publishPoolResolution(metrics, { configured: 1, resolved: 1 });
  const executor = new SolanaExecutor(makeConfig({ logOnly: true }), undefined, {
    gateConfig: PERMISSIVE_GATE, sessionMetrics: metrics,
  });
  const count = READINESS.minGateEvaluations + 5;
  for (let i = 0; i < count; i++) {
    now = start + i * (end - start) / (count - 1);
    expect((await executor.execute(makeOpportunity())).logOnly).toBe(true);
  }
  expect(deriveRecommendation(metrics.getShadowSnapshot()).verdict).toBe('ready for $1 canary');
  return { metrics, executor, fetchMock, journalPath, count };
}

function replaceSwapResponse(fetchMock: ReturnType<typeof vi.fn>, response: () => Promise<MockResponse>): void {
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((input: unknown) => String(input).includes('/swap') ? response() : original(input));
}

function expectBuildHealth(metrics: SessionMetrics, attempted: number, succeeded: number, failed: number): void {
  const health = metrics.getShadowSnapshot().readinessHealth.simulation;
  expect(health).toEqual({ attempted, succeeded, failed });
  expect(health.attempted).toBe(health.succeeded + health.failed);
  expect(signedTransaction.sign).not.toHaveBeenCalled();
  expect(sendTransaction).not.toHaveBeenCalled();
  expect(confirmTransaction).not.toHaveBeenCalled();
}

// ── Tests ──────────────────────────────────────────────────────────

describe('shadow mode safety', () => {
  beforeEach(() => {
    sendTransaction.mockReset();
    confirmTransaction.mockReset();
    signedTransaction.sign.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    journalFiles.files.clear();
    journalFiles.roots.clear();
    for (const directory of readinessDirectories.splice(0)) {
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('arbimind-readiness-')) {
        throw new Error('refusing to remove a directory outside the readiness fixture');
      }
      rmSync(resolved, { recursive: true, force: true });
    }
  });

  describe('SOLANA_LOG_ONLY=true', () => {
    it('builds a swap transaction but never calls sendTransaction', async () => {
      installFetchMock();
      const executor = new SolanaExecutor(makeConfig({ logOnly: true }), undefined, {
        gateConfig: PERMISSIVE_GATE,
      });

      const result = await executor.execute(makeOpportunity());

      // Reached the log-only return path: success, flagged log-only, no signature.
      expect(result.success).toBe(true);
      expect(result.logOnly).toBe(true);
      expect(result.signature).toBeUndefined();

      // The guarantee this whole mode rests on.
      expect(sendTransaction).not.toHaveBeenCalled();
      expect(confirmTransaction).not.toHaveBeenCalled();
      // Never even signed — log-only returns before signAndSend.
      expect(signedTransaction.sign).not.toHaveBeenCalled();
    });

    it('records the swap build in shadow metrics without recording a submission', async () => {
      installFetchMock();
      const metrics = new SessionMetrics();
      const executor = new SolanaExecutor(makeConfig({ logOnly: true }), undefined, {
        gateConfig: PERMISSIVE_GATE,
        sessionMetrics: metrics,
      });

      await executor.execute(makeOpportunity());

      const snap = metrics.getShadowSnapshot();
      expect(snap.quotesRequested).toBe(1);
      expect(snap.swapBuildsAttempted).toBe(1);
      expect(snap.swapsBuilt).toBe(1);
      expect(snap.gatePassed).toBe(1);
      // Submitted must stay zero — the report keys its "NOT LOG-ONLY" warning off it.
      expect(snap.submitted).toBe(0);
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    /**
     * Proves the log-only assertions above are not vacuous.
     *
     * A "never sends" test passes trivially if the fixture cannot reach the
     * send path at all. This runs the identical setup with logOnly:false and
     * requires sendTransaction to BE called — so the two tests together show
     * the flag is what stops the send, not a broken harness.
     */
    it('the same fixture DOES reach sendTransaction when logOnly is false', async () => {
      installFetchMock();
      sendTransaction.mockResolvedValue('mock-signature');
      confirmTransaction.mockResolvedValue({ value: { err: null } });

      const executor = new SolanaExecutor(makeConfig({ logOnly: false }), undefined, {
        gateConfig: PERMISSIVE_GATE,
      });

      await executor.execute(makeOpportunity());

      expect(sendTransaction).toHaveBeenCalled();
    });
  });

  describe('pre-execution gates', () => {
    it('SOLANA_TRADING_ENABLED=false skips before any quote, build or send', async () => {
      const fetchMock = installFetchMock();
      const executor = new SolanaExecutor(makeConfig({ tradingEnabled: false }));

      const result = await executor.execute(makeOpportunity());

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('SOLANA_TRADING_ENABLED');
      // No network call at all — not even a quote.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it('missing wallet key skips before live execution', async () => {
      const fetchMock = installFetchMock();
      const executor = new SolanaExecutor(
        makeConfig({ privateKeyBase58: '', logOnly: false, tradingEnabled: true }),
      );

      const result = await executor.execute(makeOpportunity());

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('SOLANA_PRIVATE_KEY_BASE58');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it('notional cap rejects oversized opportunities before quoting', async () => {
      const fetchMock = installFetchMock();
      const executor = new SolanaExecutor(makeConfig({ maxNotionalUsd: 5 }));

      const result = await executor.execute(
        makeOpportunity({ estimatedNotionalUsd: 500 }),
      );

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('exceeds max');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it('canary mode caps notional below the configured maximum', async () => {
      const fetchMock = installFetchMock();
      // maxNotionalUsd 50 but canaryMode forces the $5 ceiling.
      const executor = new SolanaExecutor(
        makeConfig({ maxNotionalUsd: 50, canaryMode: true }),
      );

      const result = await executor.execute(
        makeOpportunity({ estimatedNotionalUsd: 20 }),
      );

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('exceeds max $5.00');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects opportunities below the minimum expected profit', async () => {
      const fetchMock = installFetchMock();
      const executor = new SolanaExecutor(makeConfig({ minExpectedProfitUsd: 0.1 }));

      const result = await executor.execute(
        makeOpportunity({ expectedProfitUsd: 0.01 }),
      );

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('below minimum');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('stale quote guard', () => {
    it('rejects a quote older than quoteMaxAgeMs instead of sending it', async () => {
      // Delay the swap build so measurable time passes between quoting and
      // sending; with quoteMaxAgeMs=1 the age check is then deterministic
      // rather than racing a sub-millisecond execution.
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url.includes('/quote')) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                outAmount: '3050000',
                otherAmountThreshold: '3040000',
                priceImpactPct: '0.01',
                inputMint: SOL_MINT,
                outputMint: USDC_MINT,
                routePlan: [
                  { percent: 100, swapInfo: { ammKey: 'pool1', label: 'Whirlpool', inputMint: SOL_MINT, outputMint: USDC_MINT } },
                ],
              }),
            };
          }
          if (url.includes('/swap')) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return {
              ok: true,
              status: 200,
              json: async () => ({ swapTransaction: Buffer.from('fake-tx').toString('base64') }),
            };
          }
          return { ok: false, status: 404, json: async () => ({}) };
        }),
      );

      // logOnly:false so the stale check in signAndSend is actually reached.
      const executor = new SolanaExecutor(
        makeConfig({ logOnly: false, quoteMaxAgeMs: 1 }),
        undefined,
        { gateConfig: PERMISSIVE_GATE },
      );

      const result = await executor.execute(makeOpportunity());

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('quote stale');
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe('execution gate economics', () => {
    it('rejects when net expected edge is insufficient', async () => {
      installFetchMock();
      const metrics = new SessionMetrics();
      // Require more net profit than the opportunity can possibly deliver.
      const executor = new SolanaExecutor(makeConfig(), undefined, {
        gateConfig: { ...PERMISSIVE_GATE, minNetProfitUsd: 100 },
        sessionMetrics: metrics,
      });

      const result = await executor.execute(makeOpportunity());

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('execution gate');
      expect(sendTransaction).not.toHaveBeenCalled();

      const snap = metrics.getShadowSnapshot();
      expect(snap.gateEvaluated).toBe(1);
      expect(snap.gateRejected).toBe(1);
      expect(snap.gatePassed).toBe(0);
      // No build should be attempted once the gate rejects.
      expect(snap.swapBuildsAttempted).toBe(0);
    });

    it('rejects when net edge in bps is below the floor', async () => {
      installFetchMock();
      const executor = new SolanaExecutor(makeConfig(), undefined, {
        gateConfig: { ...PERMISSIVE_GATE, minEdgeBps: 100_000 },
      });

      const result = await executor.execute(makeOpportunity());

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('execution gate');
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe('route and venue filters', () => {
    it('rejects multihop routes when only direct routes are allowed', async () => {
      const fetchMock = vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/quote')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              outAmount: '3050000',
              priceImpactPct: '0.01',
              routePlan: [
                { percent: 50, swapInfo: { ammKey: 'a', label: 'Whirlpool' } },
                { percent: 50, swapInfo: { ammKey: 'b', label: 'Raydium CLMM' } },
              ],
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });
      vi.stubGlobal('fetch', fetchMock);

      const metrics = new SessionMetrics();
      const executor = new SolanaExecutor(
        makeConfig({ onlyDirectRoutes: true, allowMultihop: false }),
        undefined,
        { gateConfig: PERMISSIVE_GATE, sessionMetrics: metrics },
      );

      const result = await executor.execute(makeOpportunity());

      expect(result.skipped).toBe(true);
      expect(sendTransaction).not.toHaveBeenCalled();

      // The multihop route is still observed for reporting even though rejected.
      const snap = metrics.getShadowSnapshot();
      expect(snap.routeTypes['multihop_2']).toBe(1);
      expect(snap.skipped).toBeGreaterThan(0);
    });
  });

  describe('log-only economics recording (#411)', () => {
    it('populates expected economics and quote age, leaving realized economics empty', async () => {
      installFetchMock();
      const metrics = new SessionMetrics();
      const executor = new SolanaExecutor(makeConfig({ logOnly: true }), undefined, {
        gateConfig: PERMISSIVE_GATE,
        sessionMetrics: metrics,
      });

      await executor.execute(makeOpportunity());

      const snap = metrics.getShadowSnapshot();
      // Unreachable before #411: only ever recorded on the sign-and-send path,
      // which a log-only run never reaches.
      expect(snap.avgExpectedGrossUsd).not.toBeNull();
      expect(snap.avgExecutionFeeUsd).not.toBeNull();
      expect(snap.avgNetEdgeUsd).not.toBeNull();
      expect(snap.avgNetEdgeBpsOfNotional).not.toBeNull();
      expect(snap.avgQuoteAgeMs).not.toBeNull();

      // A log-only run has no realized PnL, and that must stay explicit rather
      // than being silently backfilled from the expected numbers above.
      expect(snap.realizedTradeCount).toBe(0);
      expect(snap.avgRealizedGrossUsd).toBeNull();
      expect(snap.avgRealizedNetEdgeUsd).toBeNull();
      expect(snap.submitted).toBe(0);
    });

    /**
     * The rejects are half the dataset. 16 of Baseline v1's 34 evaluations were
     * rejections, and their margin is what says whether the strategy is
     * marginally short or nowhere near — so economics must be recorded for a
     * REJECTED evaluation too, not only for the ones that pass the gate.
     */
    it('records economics for gate-REJECTED evaluations, not just passes', async () => {
      installFetchMock();
      const metrics = new SessionMetrics();
      // Floor far above anything the fixture can produce: guarantees rejection.
      const executor = new SolanaExecutor(makeConfig({ logOnly: true }), undefined, {
        gateConfig: { ...PERMISSIVE_GATE, minNetProfitUsd: 100 },
        sessionMetrics: metrics,
      });

      const result = await executor.execute(makeOpportunity());
      expect(result.skipped).toBe(true);

      const snap = metrics.getShadowSnapshot();
      expect(snap.gateRejected).toBe(1);
      expect(snap.gatePassed).toBe(0);
      // Never built or sent — but the economics of the rejection are captured.
      expect(snap.swapBuildsAttempted).toBe(0);
      expect(snap.submitted).toBe(0);
      expect(snap.avgExpectedGrossUsd).not.toBeNull();
      expect(snap.avgNetEdgeUsd).not.toBeNull();
      expect(snap.avgQuoteAgeMs).not.toBeNull();
    });

    /**
     * Proves the previously-dead "ready for $1 canary" branch is reachable from
     * a real log-only run, not merely from a hand-built snapshot.
     *
     * An injected clock supplies the 30h window. Only journal storage is
     * virtualized: the real journal performs every read/write/rename, and all
     * health signals come from the production path. No snapshot fields change.
     */
    it('lets a log-only run reach "ready for $1 canary" once enough evaluations accumulate', async () => {
      const { metrics, journalPath, count } = await healthyReadinessFixture();
      const snap = metrics.getShadowSnapshot();
      expect(snap.gateEvaluated).toBeGreaterThanOrEqual(READINESS.minGateEvaluations);
      expect(snap.avgNetEdgeUsd).not.toBeNull();
      expect(snap.avgNetEdgeUsd!).toBeGreaterThan(0);
      expect(snap.submitted).toBe(0);

      expect(snap.sessionDurationSec).toBe(30 * 3600);
      expectBuildHealth(metrics, count, count, 0);
      expect(new EconomicsJournal(journalPath).readAll()).toHaveLength(count);
      expect(snap.readinessHealth.observationPersistence).toEqual({ attempted: count, succeeded: count, failed: 0 });
      const statistics = calculateEconomicStatistics(snap.economicObservations);
      expect(statistics.lowerConfidenceBound!).toBeGreaterThanOrEqual(READINESS.minEconomicFloorUsd);
      const recommendation = deriveRecommendation(snap);
      expect(recommendation.verdict).toBe('ready for $1 canary');
      console.info('READINESS_FIXTURE_EVIDENCE', JSON.stringify({ runtime: process.version, hours: snap.sessionDurationSec / 3600, simulation: snap.readinessHealth.simulation, lcb: statistics.lowerConfidenceBound, verdict: recommendation.verdict }));
    });
  });

  describe('quote failure classification', () => {
    it('fails closed when SOL/USD pricing is unavailable', async () => {
      installFetchMock();
      const metrics = new SessionMetrics();
      const executor = new SolanaExecutor(makeConfig({ solPriceUsd: 0 }), undefined, {
        gateConfig: PERMISSIVE_GATE,
        sessionMetrics: metrics,
      });

      const result = await executor.execute(makeOpportunity({
        inputMint: USDC_MINT,
        outputMint: USDC_MINT,
        expectedProfitUsd: 1,
      }));

      expect(result.skipped).toBe(true);
      const snapshot = metrics.getShadowSnapshot();
      expect(snapshot.readinessHealth.feeEstimation.unavailable).toBeGreaterThan(0);
      expect(snapshot.economicObservations.at(-1)?.journal.feeEstimateAvailable).toBe(false);
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it('separates rate limiting from other RPC failures', () => {
      expect(classifyQuoteError('Jupiter quote HTTP 429')).toBe('rate_limited');
      expect(classifyQuoteError('Too Many Requests')).toBe('rate_limited');
      expect(classifyQuoteError('request timed out')).toBe('latency');
      expect(classifyQuoteError('ETIMEDOUT')).toBe('latency');
      expect(classifyQuoteError('Jupiter quote HTTP 500')).toBe('error');
    });

    it('records a failed quote without attempting a build or send', async () => {
      const fetchMock = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
      vi.stubGlobal('fetch', fetchMock);

      const metrics = new SessionMetrics();
      const executor = new SolanaExecutor(makeConfig(), undefined, {
        gateConfig: PERMISSIVE_GATE,
        sessionMetrics: metrics,
      });

      const result = await executor.execute(makeOpportunity());

      expect(result.success).toBe(false);
      const snap = metrics.getShadowSnapshot();
      expect(snap.quotesRequested).toBe(1);
      expect(snap.quoteFailures).toBe(1);
      expect(snap.rpc.rateLimited).toBe(1);
      expect(snap.swapBuildsAttempted).toBe(0);
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe('production fee budget gate/builder equivalence (#412)', () => {
    it.each([
      ['current-quote', () => ({ opportunity: makeOpportunity(), resolver: new SolPriceResolver() })],
      ['fresh-cache', () => {
        const resolver = new SolPriceResolver();
        resolver.seedCache(305, Date.now());
        return { opportunity: makeOpportunity({ inputMint: USDC_MINT, outputMint: USDC_MINT }), resolver };
      }],
      ['configured-fallback', () => ({
        opportunity: makeOpportunity({ inputMint: USDC_MINT, outputMint: USDC_MINT }),
        resolver: new SolPriceResolver(305),
      })],
    ])('uses the production executor fee path for %s price', async (source, makeCase) => {
      installFetchMock();
      const { opportunity, resolver } = makeCase();
      const metrics = new SessionMetrics();
      const executor = new SolanaExecutor(makeConfig({ logOnly: true }), undefined, {
        gateConfig: PERMISSIVE_GATE,
        sessionMetrics: metrics,
        solPriceResolver: resolver,
      });

      const result = await executor.execute(opportunity);
      expect(result.success).toBe(true);
      const row = metrics.getShadowSnapshot().economicObservations.at(-1)?.journal;
      expect(row?.feeEstimateAvailable).toBe(true);
      expect(row?.feeEstimateSource).toBe(source);
      expect(row?.estimatedFeeLamports).toBeGreaterThan(0);
      expect(row?.estimatedExecutionFeeUsd).toBeGreaterThan(0);
    });

    it.each([
      ['stale-cache', () => {
        const resolver = new SolPriceResolver();
        resolver.seedCache(305, Date.now() - 120_000);
        return resolver;
      }],
      ['unavailable', () => new SolPriceResolver()],
    ])('blocks the production gate for %s price', async (_source, createResolver) => {
      installFetchMock();
      const metrics = new SessionMetrics();
      const executor = new SolanaExecutor(makeConfig({ logOnly: true }), undefined, {
        gateConfig: PERMISSIVE_GATE,
        sessionMetrics: metrics,
        solPriceResolver: createResolver(),
      });

      const result = await executor.execute(makeOpportunity({ inputMint: USDC_MINT, outputMint: USDC_MINT }));
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('fee_estimate_unavailable');
      const row = metrics.getShadowSnapshot().economicObservations.at(-1)?.journal;
      expect(row?.feeEstimateAvailable).toBe(false);
      expect(row?.passed).toBe(false);
      expect(row?.estimatedExecutionFeeUsd).toBeNull();
    });

    it('propagates a configured priority-fee spike into gate economics and the builder', async () => {
      const builderFees: number[] = [];
      const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/quote')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              outAmount: '3050000',
              inAmount: '10000000',
              outputMint: USDC_MINT,
              priceImpactPct: '0.01',
              routePlan: [{ percent: 100, swapInfo: { ammKey: 'pool-a', label: 'Whirlpool' } }],
            }),
          };
        }
        if (url.includes('/swap')) {
          builderFees.push(Number((JSON.parse(String(init?.body)) as Record<string, unknown>).prioritizationFeeLamports));
          return { ok: true, status: 200, json: async () => ({ swapTransaction: Buffer.from('fake-tx').toString('base64') }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });
      vi.stubGlobal('fetch', fetchMock);

      const normalMetrics = new SessionMetrics();
      const spikeMetrics = new SessionMetrics();
      await new SolanaExecutor(makeConfig({ logOnly: true, priorityFeeMicroLamports: 1_000 }), undefined, {
        gateConfig: PERMISSIVE_GATE,
        sessionMetrics: normalMetrics,
      }).execute(makeOpportunity());
      await new SolanaExecutor(makeConfig({ logOnly: true, priorityFeeMicroLamports: 100_000 }), undefined, {
        gateConfig: PERMISSIVE_GATE,
        sessionMetrics: spikeMetrics,
      }).execute(makeOpportunity());

      const normal = normalMetrics.getShadowSnapshot().economicObservations.at(-1)?.journal;
      const spike = spikeMetrics.getShadowSnapshot().economicObservations.at(-1)?.journal;
      expect(spike?.estimatedFeeLamports).toBeGreaterThan(normal?.estimatedFeeLamports ?? 0);
      expect(spike?.estimatedExecutionFeeUsd).toBeGreaterThan(normal?.estimatedExecutionFeeUsd ?? 0);
      expect(builderFees[1]).toBeGreaterThan(builderFees[0]);
    });

    it('passes one fee budget from the gate to the real swap builder', async () => {
      let swapBody: Record<string, unknown> | null = null;
      const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/quote')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              outAmount: '3050000',
              inAmount: '10000000',
              outputMint: USDC_MINT,
              priceImpactPct: '0.01',
              routePlan: [{ percent: 100, swapInfo: { ammKey: 'pool-a', label: 'Whirlpool' } }],
            }),
          };
        }
        if (url.includes('/swap')) {
          swapBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return {
            ok: true,
            status: 200,
            json: async () => ({ swapTransaction: Buffer.from('fake-tx').toString('base64') }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });
      vi.stubGlobal('fetch', fetchMock);
      const directory = mkdtempSync(path.join(os.tmpdir(), 'arbimind-fee-budget-'));
      try {
        const metrics = new SessionMetrics({ economicsJournalPath: path.join(directory, 'economics.jsonl') });
        const executor = new SolanaExecutor(makeConfig({ computeUnitLimit: 200_000, priorityFeeMicroLamports: 1_000, logOnly: true }), undefined, {
          gateConfig: PERMISSIVE_GATE,
          sessionMetrics: metrics,
        });

        const result = await executor.execute(makeOpportunity());
        expect(result.success).toBe(true);
        expect(swapBody).not.toBeNull();
        expect(swapBody?.['computeUnitLimit']).toBe(200_000);
        expect(swapBody?.['prioritizationFeeLamports']).toBe(10_000);

        const row = metrics.getShadowSnapshot().economicObservations.at(-1)?.journal;
        expect(row?.feeEstimateAvailable).toBe(true);
        expect(row?.estimatedExecutionFeeUsd).toBeGreaterThan(0);
        expect(row?.estimatedExecutionFeeUsd).toBeCloseTo((15_000 / 1e9) * 305, 8);
        expect(row?.estimatedExecutionFeeUsd).toBeGreaterThan(0);
        expect(row?.estimatedExecutionFeeUsd).not.toBe(0);
        // The builder's priority fee is the same estimated priority component
        // recorded by the gate budget; changing either side must fail this test.
        expect(swapBody?.['prioritizationFeeLamports']).toBe(
          row!.estimatedFeeLamports! - 5_000,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  describe('swap build failure and simulation health propagation (#413)', () => {
    it('records Jupiter simulationError as a build failure and blocks readiness', async () => {
      const { metrics, executor, fetchMock } = await healthyReadinessFixture();
      replaceSwapResponse(fetchMock, async () => ({
        ok: true,
        status: 200,
        json: async () => ({ simulationError: 'InstructionError(0, Custom(6001))' }),
      }));

      const result = await executor.execute(makeOpportunity());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Jupiter swap simulation failed');

      const count = READINESS.minGateEvaluations + 5 + 1;
      expectBuildHealth(metrics, count, count - 1, 1);
      const recommendation = deriveRecommendation(metrics.getShadowSnapshot());
      expect(recommendation.verdict).toBe('not ready');
      expect(recommendation.reasons).toContain('quote/build/simulation failures were recorded');
    });

    it('records missing swapTransaction as a build failure and blocks readiness', async () => {
      const { metrics, executor, fetchMock } = await healthyReadinessFixture();
      replaceSwapResponse(fetchMock, async () => ({
        ok: true,
        status: 200,
        json: async () => ({ swapTransaction: '' }),
      }));

      const result = await executor.execute(makeOpportunity());
      expect(result.success).toBe(false);
      expect(result.error).toContain('missing swapTransaction');

      const count = READINESS.minGateEvaluations + 5 + 1;
      expectBuildHealth(metrics, count, count - 1, 1);
      const recommendation = deriveRecommendation(metrics.getShadowSnapshot());
      expect(recommendation.verdict).toBe('not ready');
      expect(recommendation.reasons).toContain('quote/build/simulation failures were recorded');
    });

    it('records builder network throw as a build failure and blocks readiness', async () => {
      const { metrics, executor, fetchMock } = await healthyReadinessFixture();
      replaceSwapResponse(fetchMock, async () => {
        throw new Error('ECONNRESET while posting to Jupiter /swap');
      });

      const result = await executor.execute(makeOpportunity());
      expect(result.success).toBe(false);
      expect(result.error).toContain('ECONNRESET');

      const count = READINESS.minGateEvaluations + 5 + 1;
      expectBuildHealth(metrics, count, count - 1, 1);
      const recommendation = deriveRecommendation(metrics.getShadowSnapshot());
      expect(recommendation.verdict).toBe('not ready');
      expect(recommendation.reasons).toContain('quote/build/simulation failures were recorded');
    });
  });
});
