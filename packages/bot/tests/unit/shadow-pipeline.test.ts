import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import type { SolanaScanner } from '../../src/solana/Scanner';
import type { SolanaExecutor } from '../../src/solana/Executor';
import type { SessionMetrics } from '../../src/solana/SessionMetrics';

// Load real validation dependencies during collection, outside per-case timers.
import 'ethers';
import 'viem/chains';

const boundary = vi.hoisted(() => ({
  sign: vi.fn(), send: vi.fn(), confirm: vi.fn(),
  transaction: { sign: vi.fn(), message: { header: {}, staticAccountKeys: [], compiledInstructions: [] } },
}));
vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual<typeof import('@solana/web3.js')>('@solana/web3.js');
  return {
    ...actual,
    Connection: class {
      getRecentPrioritizationFees = vi.fn().mockResolvedValue([]);
      sendTransaction = boundary.send;
      confirmTransaction = boundary.confirm;
    },
    VersionedTransaction: { deserialize: vi.fn(() => ({ ...boundary.transaction, sign: boundary.sign })) },
  };
});
vi.mock('../../src/utils/Logger', () => ({
  Logger: class { info(): void {} warn(): void {} error(): void {} debug(): void {} },
}));
// Replace only the artifact I/O boundary; use the production parser and assertion.
vi.mock('../../src/solana/RuntimeProvenance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/solana/RuntimeProvenance')>();
  return {
    ...actual,
    readRuntimeProvenance: () => actual.readRuntimeProvenance({}, () => ({
      sourceSha: 'a'.repeat(40), buildAtIso: new Date().toISOString(),
    })),
  };
});

type ScannerInternals = {
  executor: SolanaExecutor | null;
  sessionMetrics: SessionMetrics;
  inventoryManager: unknown;
  fundingManager: unknown;
  resolveWallet(): unknown;
  maybeExecuteTrade(...args: unknown[]): Promise<void>;
};

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
let directory: string;
let scanner: SolanaScanner | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
const directExecutors: SolanaExecutor[] = [];

async function createScanner(): Promise<ScannerInternals> {
  const { SolanaScanner } = await import('../../src/solana/Scanner');
  scanner = new SolanaScanner();
  return scanner as unknown as ScannerInternals;
}

async function driveOpportunity(internals: ScannerInternals, expectedProfitPct = 10): Promise<void> {
  await internals.maybeExecuteTrade('observed-pool', 'LONG', {
    baseSymbol: 'SOL', quoteSymbol: 'USDC', baseMint: SOL, quoteMint: USDC,
    priceUsd: 150, liquidityUsd: 1_000_000, volumeH24: 2_000_000,
  }, 0.99, expectedProfitPct);
}

async function evidence(internals: ScannerInternals) {
  await internals.executor?.stopShadowSnapshots();
  const { EconomicsJournal } = await import('../../src/solana/EconomicsJournal');
  const { readShadowSnapshot } = await import('../../src/solana/ShadowReport');
  return {
    rows: new EconomicsJournal(path.join(directory, 'economics.jsonl')).readAll(),
    snapshot: await readShadowSnapshot(path.join(directory, 'snapshot.json')),
  };
}

function expectNoExecution(internals: ScannerInternals): void {
  expect(boundary.sign).not.toHaveBeenCalled();
  expect(boundary.send).not.toHaveBeenCalled();
  expect(boundary.confirm).not.toHaveBeenCalled();
  expect(internals.sessionMetrics.getSummary()).toMatchObject({ submitted: 0, confirmed: 0 });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  directory = mkdtempSync(path.join(os.tmpdir(), 'arbimind-shadow-pipeline-'));
  const env = {
    EVM_SCANNER_ENABLED: 'false', EVM_TRADING_ENABLED: 'false',
    SOLANA_SCANNER_ENABLED: 'true', SOLANA_TRADING_ENABLED: 'false',
    SOLANA_LOG_ONLY: 'true', LOG_ONLY: 'true', BOT_LOG_ONLY: 'true',
    SOLANA_PRIVATE_KEY_BASE58: '', SOLANA_AUTO_FUND_ENABLED: 'false',
    SOLANA_ENABLED_PAIRS: 'SOL/USDC', SOLANA_WATCHED_POOLS: 'observed-pool',
    SOLANA_TRADE_SIZE_MODE: 'fixed', SOLANA_SOL_PRICE_USD: '150',
    SOLANA_RPC_URL: 'http://localhost:8899', SOLANA_RPC_URL_MAINNET_BETA: '',
    SOLANA_ECONOMICS_JOURNAL_PATH: path.join(directory, 'economics.jsonl'),
    SOLANA_SHADOW_SNAPSHOT_PATH: path.join(directory, 'snapshot.json'),
    SOLANA_SHADOW_SNAPSHOT_INTERVAL_MS: '1000', AI_SCORING_MODE: 'local',
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/quote')) return {
      ok: true, status: 200, json: async () => ({
        inAmount: '5000000', outAmount: '33333333', otherAmountThreshold: '33233333',
        inputMint: USDC, outputMint: SOL, priceImpactPct: '0.01',
        routePlan: [{ percent: 100, swapInfo: { label: 'Whirlpool', ammKey: 'observed-pool', inputMint: USDC, outputMint: SOL } }],
      }),
    };
    if (url.endsWith('/swap')) return {
      ok: true, status: 200, json: async () => ({ swapTransaction: Buffer.from('unsigned-test-build').toString('base64') }),
    };
    throw new Error('Unexpected external request in shadow pipeline fixture');
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await scanner?.stop();
  for (const executor of directExecutors.splice(0)) await executor.stopShadowSnapshots();
  scanner = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('arbimind-shadow-pipeline-')) {
    throw new Error('refusing cleanup outside the shadow fixture');
  }
  rmSync(resolved, { recursive: true, force: true });
});

describe('production scanner shadow reachability', () => {
  it('persists one scanner economics evaluation with trading disabled and no signer', async () => {
    const internals = await createScanner();
    await driveOpportunity(internals);
    await internals.executor?.stopShadowSnapshots();
    const { EconomicsJournal } = await import('../../src/solana/EconomicsJournal');
    const rows = new EconomicsJournal(path.join(directory, 'economics.jsonl')).readAll();
    const metrics = internals.sessionMetrics.getShadowSnapshot();
    expect(internals.executor).not.toBeNull();
    expect(metrics.quotesRequested).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.passed).toBe(true);
    const { readShadowSnapshot } = await import('../../src/solana/ShadowReport');
    const reopened = await readShadowSnapshot(path.join(directory, 'snapshot.json'));
    expect(reopened.gateEvaluated).toBe(1);
    expect(reopened.economicObservations).toHaveLength(1);
    expectNoExecution(internals);
  });

  it.each([
    { name: 'gate rejection', profitPct: 3, solPrice: '150', reason: 'net_below_floor' },
    { name: 'unavailable fee', profitPct: 10, solPrice: '0', reason: 'fee_estimate_unavailable' },
  ])('journals exactly one production observation for $name', async ({ profitPct, solPrice, reason }) => {
    vi.stubEnv('SOLANA_SOL_PRICE_USD', solPrice);
    const internals = await createScanner();
    await driveOpportunity(internals, profitPct);
    const { rows, snapshot } = await evidence(internals);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ passed: false, rejectReason: reason });
    expect(snapshot).toMatchObject({ quotesRequested: 1, gateEvaluated: 1, gateRejected: 1, swapBuildsAttempted: 0 });
    if (reason === 'fee_estimate_unavailable') {
      expect(rows[0]).toMatchObject({ feeEstimateAvailable: false, estimatedExecutionFeeUsd: null, feeEstimateSource: 'unavailable', netExpectedUsd: null });
    }
    expectNoExecution(internals);
  });

  it('writes and reopens the periodic snapshot from production metrics', async () => {
    const internals = await createScanner();
    await driveOpportunity(internals);
    const snapshotPath = path.join(directory, 'snapshot.json');
    await vi.waitFor(() => expect(existsSync(snapshotPath)).toBe(true), { timeout: 5000, interval: 25 });
    const { readShadowSnapshot } = await import('../../src/solana/ShadowReport');
    const first = await readShadowSnapshot(snapshotPath);
    const reopened = await readShadowSnapshot(snapshotPath);
    expect(first.schemaVersion).toBe(1);
    expect(first.gateEvaluated).toBe(1);
    expect(reopened.gateEvaluated).toBe(first.gateEvaluated);
    expect(reopened.economicObservations).toHaveLength(1);
    expectNoExecution(internals);
  });

  it('keeps unsigned build failure visible in the durable snapshot', async () => {
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: unknown) => String(input).endsWith('/swap')
      ? Promise.resolve({ ok: true, status: 200, json: async () => ({ simulationError: 'controlled build failure' }) })
      : originalFetch(input));
    const internals = await createScanner();
    await driveOpportunity(internals);
    const { rows, snapshot } = await evidence(internals);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.passed).toBe(true);
    expect(snapshot.readinessHealth.simulation).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
    expect(snapshot.swapBuildFailed).toBe(1);
    expectNoExecution(internals);
  });

  it.each(['false', 'true'])('LOG_ONLY has no signer or funding authority with trading=%s', async (trading) => {
    const unrelatedCredential = bs58.encode(Keypair.generate().secretKey);
    vi.stubEnv('SOLANA_TRADING_ENABLED', trading);
    vi.stubEnv('SOLANA_AUTO_FUND_ENABLED', 'true');
    vi.stubEnv('SOLANA_TREASURY_SECRET_KEY', unrelatedCredential);
    vi.stubEnv('SOLANA_ARB_SECRET_KEY', unrelatedCredential);
    vi.stubEnv('SOLANA_PRIVATE_KEY_BASE58Y_BASE58', unrelatedCredential);
    const fromSecretKey = vi.spyOn(Keypair, 'fromSecretKey');
    const fromSeed = vi.spyOn(Keypair, 'fromSeed');
    const generate = vi.spyOn(Keypair, 'generate');
    const internals = await createScanner();
    await driveOpportunity(internals);
    expect(internals.inventoryManager).toBeNull();
    expect(internals.fundingManager).toBeNull();
    expect(internals.resolveWallet()).toBeNull();
    expect(fromSecretKey).not.toHaveBeenCalled();
    expect(fromSeed).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    const { rows, snapshot } = await evidence(internals);
    expect(rows).toHaveLength(1);
    expect(snapshot.readinessHealth.simulation).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expectNoExecution(internals);
  });

  it.each([
    { scannerEnabled: 'true', logOnly: 'false' },
    { scannerEnabled: 'false', logOnly: 'true' },
  ])('does not initialize an inactive evaluator ($scannerEnabled / false / $logOnly)', async ({ scannerEnabled, logOnly }) => {
    vi.stubEnv('SOLANA_SCANNER_ENABLED', scannerEnabled);
    vi.stubEnv('SOLANA_LOG_ONLY', logOnly);
    const internals = await createScanner();
    await driveOpportunity(internals);
    expect(internals.executor).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(path.join(directory, 'economics.jsonl'))).toBe(false);
    expect(existsSync(path.join(directory, 'snapshot.json'))).toBe(false);
    expectNoExecution(internals);
  });

  it('does not load even an explicitly configured trading signer in shadow', async () => {
    const credential = bs58.encode(Keypair.generate().secretKey);
    vi.stubEnv('SOLANA_PRIVATE_KEY_BASE58', credential);
    const fromSecretKey = vi.spyOn(Keypair, 'fromSecretKey');
    const fromSeed = vi.spyOn(Keypair, 'fromSeed');
    const generate = vi.spyOn(Keypair, 'generate');
    const internals = await createScanner();
    await driveOpportunity(internals);
    expect(fromSecretKey).not.toHaveBeenCalled();
    expect(fromSeed).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect((await evidence(internals)).rows).toHaveLength(1);
    expectNoExecution(internals);
  });

  it.each([
    { trading: 'false', logOnly: 'true' },
    { trading: 'false', logOnly: 'false' },
    { trading: 'true', logOnly: 'true' },
  ])('rejects a direct live-boundary call before signing ($trading / $logOnly)', async ({ trading, logOnly }) => {
    vi.stubEnv('SOLANA_TRADING_ENABLED', trading);
    vi.stubEnv('SOLANA_LOG_ONLY', logOnly);
    const internals = await createScanner();
    const { SolanaExecutor } = await import('../../src/solana/Executor');
    const { solanaExecutorConfig } = await import('../../src/solana/config');
    const executor = internals.executor ?? new SolanaExecutor(solanaExecutorConfig, undefined, { sessionMetrics: internals.sessionMetrics });
    if (!internals.executor) directExecutors.push(executor);
    const unexpectedAccess = new Proxy({}, { get() { throw new Error('live dependency accessed before authorization'); } });
    const liveBoundary = executor as unknown as { signAndSend(...args: unknown[]): Promise<{ skipped?: boolean; skipReason?: string }> };
    const result = await liveBoundary.signAndSend(
      { sign: boundary.sign }, unexpectedAccess,
      { inputMint: USDC, outputMint: SOL, amountLamports: 5_000_000, estimatedNotionalUsd: 5, expectedProfitUsd: 0.5, spreadBps: 1000, label: 'USDC->SOL' },
      unexpectedAccess, unexpectedAccess,
    );
    expect(result).toMatchObject({ skipped: true, skipReason: 'live execution authority disabled' });
    expectNoExecution(internals);
  });

  it('live-capable mode still requires the explicit trading signer', async () => {
    vi.stubEnv('SOLANA_TRADING_ENABLED', 'true');
    vi.stubEnv('SOLANA_LOG_ONLY', 'false');
    const unrelatedCredential = bs58.encode(Keypair.generate().secretKey);
    vi.stubEnv('SOLANA_TREASURY_SECRET_KEY', unrelatedCredential);
    vi.stubEnv('SOLANA_ARB_SECRET_KEY', unrelatedCredential);
    const internals = await createScanner();
    expect(internals.executor).not.toBeNull();
    await driveOpportunity(internals);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(internals.sessionMetrics.getSummary().gateEvaluated).toBe(0);
    expectNoExecution(internals);

    // Positive control for the signer-loading spies: live-capable construction
    // consumes the explicit trading credential through the real decoder.
    const fromSecretKey = vi.spyOn(Keypair, 'fromSecretKey');
    const { SolanaExecutor } = await import('../../src/solana/Executor');
    const { solanaExecutorConfig } = await import('../../src/solana/config');
    const liveExecutor = new SolanaExecutor({ ...solanaExecutorConfig, privateKeyBase58: unrelatedCredential });
    directExecutors.push(liveExecutor);
    expect(fromSecretKey).toHaveBeenCalledTimes(1);
    expectNoExecution(internals);
  });
});
