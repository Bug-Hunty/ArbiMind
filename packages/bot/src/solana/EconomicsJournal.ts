import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';

export interface JournalObservation {
  schemaVersion: 1;
  timestampMs: number;
  poolAddress: string | null;
  pair: string;
  ammLabel: string;
  routeType: string;
  notionalUsd: number;
  expectedGrossUsd: number;
  estimatedExecutionFeeUsd: number | null;
  estimatedSlippageCostUsd: number | null;
  riskBufferUsd: number;
  executionHaircutUsd: number;
  netExpectedUsd: number | null;
  edgeBps: number | null;
  quoteAgeMs: number | null;
  feeEstimateAvailable: boolean;
  feeEstimateSource: string | null;
  feeEstimateAgeMs: number | null;
  passed: boolean;
  rejectReason: string | null;
  simulationAttempted: boolean;
  simulationSucceeded: boolean;
  simulationFailureReason: string | null;
}

const FORBIDDEN_FIELD_NAMES = /private|secret|credential|authorization|signature|rpcurl|rpc_url|token/i;

export class EconomicsJournal {
  constructor(private readonly filePath: string) {}

  append(observation: JournalObservation): void {
    for (const key of Object.keys(observation)) {
      if (FORBIDDEN_FIELD_NAMES.test(key)) throw new Error(`forbidden journal field: ${key}`);
    }
    const directory = path.dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const existing = existsSync(this.filePath) ? readFileSync(this.filePath, 'utf8') : '';
    const line = `${JSON.stringify(observation)}\n`;
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${existing}${line}`, { encoding: 'utf8', flag: 'w' });
    renameSync(temporaryPath, this.filePath);
  }

  readAll(): JournalObservation[] {
    if (!existsSync(this.filePath)) return [];
    return readFileSync(this.filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JournalObservation);
  }
}
