import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const doubles = vi.hoisted(() => ({
  inventoryOptions: vi.fn(), fundingOptions: vi.fn(),
  refreshBalances: vi.fn().mockResolvedValue({ solBalance: 0 }),
  startRebalanceLoop: vi.fn(), checkAndRebalance: vi.fn(),
}));

vi.mock('../../src/utils/Logger', () => ({ Logger: class {
  info = vi.fn(); warn = vi.fn(); error = vi.fn(); debug = vi.fn();
} }));
vi.mock('../../src/solana/Executor', () => ({ SolanaExecutor: class {
  setInventoryManager = vi.fn(); execute = vi.fn();
} }));
vi.mock('../../src/solana/InventoryManager', () => ({ SolanaInventoryManager: class {
  constructor(options: unknown) { doubles.inventoryOptions(options); }
  logStartupConfig = vi.fn(); refreshBalances = doubles.refreshBalances;
  startRebalanceLoop = doubles.startRebalanceLoop; stopRebalanceLoop = vi.fn();
} }));
vi.mock('../../src/solana/FundingManager', () => ({ FundingManager: class {
  constructor(options: unknown) { doubles.fundingOptions(options); }
  checkAndRebalance = doubles.checkAndRebalance;
} }));
vi.mock('../../src/solana/SessionMetrics', () => ({ SessionMetrics: class {
  setAiScoringMode = vi.fn(); startPeriodicSummary = vi.fn();
  stopPeriodicSummary = vi.fn(); emitSummary = vi.fn();
} }));

import { SolanaScanner } from '../../src/solana/Scanner';
import { solanaConfig, solanaExecutorConfig, inventoryConfig } from '../../src/solana/config';

const originals = {
  scanner: { ...solanaConfig }, executor: { ...solanaExecutorConfig }, inventory: { ...inventoryConfig },
};
type ScannerInternals = { scanLoop(): Promise<void>; scanPools(): Promise<void>; fetchDexPair(pool: string): Promise<null> };

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(solanaConfig, { enabled: true, watchedPools: ['fixture-pool'] });
  Object.assign(solanaExecutorConfig, {
    tradingEnabled: true, logOnly: true, rpcUrl: 'http://localhost:8899',
    privateKeyBase58: bs58.encode(Keypair.generate().secretKey),
  });
  Object.assign(inventoryConfig, { autoFundEnabled: true, autoRebalanceEnabled: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  Object.assign(solanaConfig, originals.scanner);
  Object.assign(solanaExecutorConfig, originals.executor);
  Object.assign(inventoryConfig, originals.inventory);
  vi.restoreAllMocks();
});

describe('scanner funding paths respect shadow mode', () => {
  it.each([true, false])('with logOnly=%s, only an execution-capable scanner can invoke funding', async (logOnly) => {
    solanaExecutorConfig.logOnly = logOnly;
    const scanner = new SolanaScanner();
    const internals = scanner as unknown as ScannerInternals;
    // Drive one tick deterministically; no timers, network or transaction APIs.
    vi.spyOn(internals, 'scanLoop').mockResolvedValue();
    vi.spyOn(internals, 'fetchDexPair').mockResolvedValue(null);
    try {
      scanner.start();
      await internals.scanPools();
      expect(doubles.inventoryOptions.mock.calls[0]![0].config.autoRebalanceEnabled).toBe(!logOnly);
      expect(doubles.fundingOptions.mock.calls[0]![0].autoRebalanceEnabled).toBe(!logOnly);
      expect(doubles.startRebalanceLoop).toHaveBeenCalledTimes(logOnly ? 0 : 1);
      expect(doubles.checkAndRebalance).toHaveBeenCalledTimes(logOnly ? 0 : 1);
      expect(doubles.refreshBalances).toHaveBeenCalledTimes(1);
    } finally { scanner.stop(); }
  });

  it('does not invoke funding when trading is disabled, even with rebalance configured', async () => {
    Object.assign(solanaExecutorConfig, { tradingEnabled: false, logOnly: false });
    const scanner = new SolanaScanner();
    const internals = scanner as unknown as ScannerInternals;
    vi.spyOn(internals, 'scanLoop').mockResolvedValue();
    vi.spyOn(internals, 'fetchDexPair').mockResolvedValue(null);
    try {
      scanner.start();
      await internals.scanPools();
      expect(doubles.fundingOptions.mock.calls[0]![0].autoRebalanceEnabled).toBe(false);
      expect(doubles.startRebalanceLoop).not.toHaveBeenCalled();
      expect(doubles.checkAndRebalance).not.toHaveBeenCalled();
    } finally { scanner.stop(); }
  });
});
