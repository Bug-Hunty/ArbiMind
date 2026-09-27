import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { EconomicsJournal, type JournalObservation } from '../../src/solana/EconomicsJournal';

function observation(passed: boolean, feeAvailable = true): JournalObservation {
  return {
    schemaVersion: 1,
    timestampMs: Date.now(),
    poolAddress: 'pool-a',
    pair: 'SOL/USDC',
    ammLabel: 'Whirlpool',
    routeType: 'direct',
    notionalUsd: 3,
    expectedGrossUsd: 1,
    estimatedExecutionFeeUsd: feeAvailable ? 0.01 : null,
    estimatedSlippageCostUsd: 0.02,
    riskBufferUsd: 0.03,
    executionHaircutUsd: 0.04,
    netExpectedUsd: feeAvailable ? 0.9 : null,
    edgeBps: feeAvailable ? 3000 : null,
    quoteAgeMs: 12,
    feeEstimateAvailable: feeAvailable,
    feeEstimateSource: feeAvailable ? 'current-quote' : 'unavailable',
    feeEstimateAgeMs: feeAvailable ? 0 : null,
    estimatedFeeLamports: feeAvailable ? 15_000 : null,
    passed,
    rejectReason: passed ? null : 'net_below_floor',
    simulationAttempted: false,
    simulationSucceeded: false,
    simulationFailureReason: null,
  };
}

describe('EconomicsJournal', () => {
  it('writes pass, reject, and unavailable-fee rows and reopens after restart', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'arbimind-journal-'));
    const filePath = path.join(directory, 'economics.jsonl');
    const journal = new EconomicsJournal(filePath);
    journal.append(observation(true));
    journal.append(observation(false));
    journal.append(observation(false, false));

    const reopened = new EconomicsJournal(filePath);
    expect(reopened.readAll()).toHaveLength(3);
    expect(reopened.readAll()[2].feeEstimateAvailable).toBe(false);
    expect(readFileSync(filePath, 'utf8').trim().split(/\r?\n/)).toHaveLength(3);
    rmSync(directory, { recursive: true, force: true });
  });

  it('rejects secret-bearing field names', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'arbimind-journal-'));
    const journal = new EconomicsJournal(path.join(directory, 'economics.jsonl'));
    expect(() => journal.append({ ...observation(true), authorizationHeader: 'nope' } as never)).toThrow();
    rmSync(directory, { recursive: true, force: true });
  });
});
