/**
 * Jupiter swap-build request contract.
 *
 * Regression guard for a shipped-default defect: `asLegacyTransaction` was sent
 * on the /swap body but never on the /quote request. Jupiter then rejected
 * every build with
 *
 *   HTTP 400  "asLegacyTransaction cannot be used with
 *              quoteResponse.transactionVersion"   errorCode NOT_SUPPORTED
 *
 * which meant no signing-ready transaction could be produced in any direction.
 * The existing suite missed it because every fixture set the flag to `false`,
 * the one value for which the two requests happen to agree.
 *
 * The invariant under test is therefore the agreement itself, asserted for
 * BOTH values of the flag and BOTH quote directions.
 *
 * No transaction is signed or submitted: these run with logOnly = true.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/Logger', () => ({
  Logger: class {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
  },
}));

const { sendTransaction } = vi.hoisted(() => ({ sendTransaction: vi.fn() }));

vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual<typeof import('@solana/web3.js')>('@solana/web3.js');
  class MockConnection {
    sendTransaction = sendTransaction;
    getLatestBlockhash = vi.fn().mockResolvedValue({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 1_000,
    });
    getRecentPrioritizationFees = vi.fn().mockResolvedValue([]);
    getBalance = vi.fn().mockResolvedValue(1_000_000_000);
  }
  return {
    ...actual,
    Connection: MockConnection,
    VersionedTransaction: {
      deserialize: vi.fn(() => ({ message: { staticAccountKeys: [], compiledInstructions: [] } })),
    },
  };
});

import { SolanaExecutor } from '../../src/solana/Executor';
import type { SolanaExecutorConfig, SwapOpportunity } from '../../src/solana/Executor';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function makeConfig(asLegacyTransaction: boolean): SolanaExecutorConfig {
  return {
    tradingEnabled: false,
    logOnly: true,
    canaryMode: false,
    onlyDirectRoutes: true,
    allowMultihop: false,
    computeUnitLimit: 200_000,
    priorityFeeMicroLamports: 1_000,
    maxPriceImpactPct: 5,
    ammDenylist: [],
    ammAllowlist: [],
    templateDenylist: [],
    raydiumFingerprintDenylist: [],
    asLegacyTransaction,
    tradeSizeMode: 'fixed',
    minSpreadBps: 0,
    allocationPct: 0.5,
    minTradeSizeUsd: 0,
    maxTradeSizeUsd: 100,
    drawdownTriggerPct: 0,
    drawdownScale: 1,
    maxNotionalUsd: 100,
    minNotionalUsd: 0,
    minExpectedProfitUsd: 0,
    maxDailyLossUsd: 100,
    stopLossPct: 0,
    takeProfitPct: 0,
    maxSlippageBps: 50,
    quoteMaxAgeMs: 60_000,
    solPriceUsd: 150,
    rpcUrl: 'http://localhost:8899',
    privateKeyBase58: '',
    jupiterBaseUrl: 'https://jupiter.invalid',
    riskPolicy: {
      denyTiers: [],
      canaryTiers: [],
      canaryMaxNotionalUsd: 100,
      minEdgeBumpBps: 0,
      incidentCooldownDays: 0,
      denyIncidentTypes: [],
    },
  } as SolanaExecutorConfig;
}

const PERMISSIVE_GATE = {
  minNetProfitUsd: 0,
  riskBufferUsd: 0,
  slippageFallbackUsd: 0,
  slippageDiscountFactor: 0,
  executionHaircutUsd: 0,
  minEdgeBps: 0,
};

interface Captured {
  quoteUrls: string[];
  swapBodies: Record<string, unknown>[];
}

/**
 * Mirrors Jupiter's real behaviour: a quote requested WITHOUT
 * asLegacyTransaction carries transactionVersion, and /swap then refuses a
 * legacy build against it. Without this the mock would accept the very request
 * the production API rejects, and the test would pass while the bot stayed
 * broken.
 */
function installFetchMock(captured: Captured): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('/quote')) {
      captured.quoteUrls.push(url);
      const legacyRequested = new URL(url).searchParams.get('asLegacyTransaction') === 'true';
      const body: Record<string, unknown> = {
        inAmount: '10000000',
        outAmount: '3050000',
        otherAmountThreshold: '3040000',
        priceImpactPct: '0.01',
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        routePlan: [
          { percent: 100, swapInfo: { ammKey: 'pool1', label: 'Whirlpool', inputMint: SOL_MINT, outputMint: USDC_MINT } },
        ],
      };
      if (!legacyRequested) body['transactionVersion'] = 0;
      return { ok: true, status: 200, json: async () => body };
    }

    if (url.includes('/swap')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      captured.swapBodies.push(body);
      const quote = (body['quoteResponse'] ?? {}) as Record<string, unknown>;
      if (body['asLegacyTransaction'] === true && quote['transactionVersion'] !== undefined) {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: 'asLegacyTransaction cannot be used with quoteResponse.transactionVersion',
            errorCode: 'NOT_SUPPORTED',
          }),
          text: async () =>
            '{"error":"asLegacyTransaction cannot be used with quoteResponse.transactionVersion"}',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ swapTransaction: Buffer.from('fake-tx').toString('base64') }),
      };
    }

    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  }));
}

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

describe('Jupiter swap-build request contract', () => {
  let captured: Captured;

  beforeEach(() => {
    captured = { quoteUrls: [], swapBodies: [] };
    installFetchMock(captured);
    sendTransaction.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const asLegacyTransaction of [true, false]) {
    for (const [name, opportunity] of [
      ['SOL->USDC', makeOpportunity()],
      ['USDC->SOL', makeOpportunity({ inputMint: USDC_MINT, outputMint: SOL_MINT })],
    ] as const) {
      it(`sends asLegacyTransaction=${asLegacyTransaction} on the quote as well as the swap (${name})`, async () => {
        const executor = new SolanaExecutor(makeConfig(asLegacyTransaction), undefined, {
          gateConfig: PERMISSIVE_GATE,
        });

        const result = await executor.execute(opportunity);

        expect(captured.quoteUrls).toHaveLength(1);
        const quoteFlag = new URL(captured.quoteUrls[0]!).searchParams.get('asLegacyTransaction');
        expect(quoteFlag).toBe(String(asLegacyTransaction));

        expect(captured.swapBodies).toHaveLength(1);
        expect(captured.swapBodies[0]!['asLegacyTransaction']).toBe(asLegacyTransaction);

        // The invariant: the two requests must agree, or Jupiter 400s.
        expect(quoteFlag).toBe(String(captured.swapBodies[0]!['asLegacyTransaction']));

        // The build must actually succeed and stop at log-only.
        expect(result.success).toBe(true);
        expect(result.logOnly).toBe(true);
        expect(sendTransaction).not.toHaveBeenCalled();
      });
    }
  }

  it('reproduces the original defect when the quote omits the flag', async () => {
    // Guards the mock itself: if a future change stops sending the flag on the
    // quote, this proves the failure is still detectable rather than silently
    // accepted by a too-permissive stub.
    const legacyQuoteless = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/quote')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            inAmount: '10000000',
            outAmount: '3050000',
            otherAmountThreshold: '3040000',
            priceImpactPct: '0.01',
            inputMint: SOL_MINT,
            outputMint: USDC_MINT,
            transactionVersion: 0,
            routePlan: [
              { percent: 100, swapInfo: { ammKey: 'pool1', label: 'Whirlpool', inputMint: SOL_MINT, outputMint: USDC_MINT } },
            ],
          }),
        };
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const quote = (body['quoteResponse'] ?? {}) as Record<string, unknown>;
      if (body['asLegacyTransaction'] === true && quote['transactionVersion'] !== undefined) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ errorCode: 'NOT_SUPPORTED' }),
          text: async () => '{"errorCode":"NOT_SUPPORTED"}',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ swapTransaction: Buffer.from('fake-tx').toString('base64') }),
      };
    });
    vi.stubGlobal('fetch', legacyQuoteless);

    const executor = new SolanaExecutor(makeConfig(true), undefined, { gateConfig: PERMISSIVE_GATE });
    const result = await executor.execute(makeOpportunity());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/swap build failed/i);
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});
