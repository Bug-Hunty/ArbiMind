import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// Load the external SDK in setup; the config itself must still be imported
// after each test's environment changes. Cold disk I/O is not a gate timeout.
beforeAll(async () => { await import('ethers'); }, 60_000);

describe('getEligibleDexesForPair', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    // Preserve the process.env object shared with env-sensitive modules.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  function setArbitrumProfile() {
    process.env['NETWORK'] = 'mainnet';
    process.env['EVM_CHAIN'] = 'arbitrum';
  }

  async function importDexes() {
    return await import('../../src/config/dexes');
  }

  it('returns V3 only for WETH/USDC on Arbitrum', async () => {
    setArbitrumProfile();
    const { getEligibleDexesForPair } = await importDexes();
    const dexes = getEligibleDexesForPair('WETH', 'USDC');
    const names = dexes.map(([n]: [string, unknown]) => n);

    expect(names).toContain('UNISWAP_V3');
    expect(names).not.toContain('SUSHISWAP');
  });

  it('returns V3 + Sushi for WETH/USDC.e on Arbitrum', async () => {
    setArbitrumProfile();
    const { getEligibleDexesForPair } = await importDexes();
    const dexes = getEligibleDexesForPair('WETH', 'USDC.e');
    const names = dexes.map(([n]: [string, unknown]) => n);

    expect(names).toContain('UNISWAP_V3');
    expect(names).toContain('SUSHISWAP');
  });

  it('returns V3 only for USDC/DAI on Arbitrum', async () => {
    setArbitrumProfile();
    const { getEligibleDexesForPair } = await importDexes();
    const dexes = getEligibleDexesForPair('USDC', 'DAI');
    const names = dexes.map(([n]: [string, unknown]) => n);

    expect(names).toContain('UNISWAP_V3');
    expect(names).not.toContain('SUSHISWAP');
  });

  it('returns all enabled DEXes for unknown pair on Arbitrum', async () => {
    setArbitrumProfile();
    const { getEligibleDexesForPair } = await importDexes();
    const dexes = getEligibleDexesForPair('WETH', 'WBTC');
    const names = dexes.map(([n]: [string, unknown]) => n);

    // Unknown pair — should return all enabled (V3 + Sushi on Arbitrum)
    expect(names).toContain('UNISWAP_V3');
    expect(names).toContain('SUSHISWAP');
  });

  it('falls back to all enabled DEXes when pair policy is empty', async () => {
    setArbitrumProfile();
    // Override WETH/USDC to list a DEX key that doesn't exist as enabled
    process.env['PAIR_DEX_OVERRIDE'] = 'WETH/USDC:NONEXISTENT_DEX';
    const { getEligibleDexesForPair } = await importDexes();
    const dexes = getEligibleDexesForPair('WETH', 'USDC');
    const names = dexes.map(([n]: [string, unknown]) => n);

    // Filter produces empty → fallback to all enabled
    expect(names).toContain('UNISWAP_V3');
    expect(names).toContain('SUSHISWAP');
  });

  it('respects PAIR_DEX_OVERRIDE env var', async () => {
    setArbitrumProfile();
    // Override WETH/USDC to include Sushi
    process.env['PAIR_DEX_OVERRIDE'] = 'WETH/USDC:UNISWAP_V3,SUSHISWAP';
    const { getEligibleDexesForPair } = await importDexes();
    const dexes = getEligibleDexesForPair('WETH', 'USDC');
    const names = dexes.map(([n]: [string, unknown]) => n);

    expect(names).toContain('UNISWAP_V3');
    expect(names).toContain('SUSHISWAP');
  });

  it('handles reverse pair lookup (DAI/USDC maps to USDC/DAI policy)', async () => {
    setArbitrumProfile();
    const { getEligibleDexesForPair } = await importDexes();
    const dexes = getEligibleDexesForPair('DAI', 'USDC');
    const names = dexes.map(([n]: [string, unknown]) => n);

    expect(names).toContain('UNISWAP_V3');
    expect(names).not.toContain('SUSHISWAP');
  });
});
