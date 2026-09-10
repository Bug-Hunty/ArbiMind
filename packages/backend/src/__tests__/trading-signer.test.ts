import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

jest.mock('../routes/solanaTx', () => ({ getConnection: jest.fn() }));
jest.mock('../services/SolanaScanner', () => ({ addLog: jest.fn(), updateOpportunity: jest.fn() }));

const original = { ...process.env };
beforeEach(() => { jest.resetModules(); });
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
});

describe('backend trading and treasury separation', () => {
  it('fails live initialization with only treasury or legacy keys and never aliases env vars', () => {
    delete process.env.SOLANA_PRIVATE_KEY_BASE58;
    delete process.env.SOLANA_TREASURY_SECRET_KEY;
    const fixture = bs58.encode(Keypair.generate().secretKey);
    process.env.TREASURY_PRIVATE_KEY = fixture;
    process.env.SOLANA_ARB_SECRET_KEY = fixture;
    const executor = require('../services/SolanaExecutor') as typeof import('../services/SolanaExecutor');
    expect(() => executor.initializeExecutor()).toThrow('Missing SOLANA_PRIVATE_KEY_BASE58');
    expect(() => executor.setBotMode('live')).toThrow('Missing SOLANA_PRIVATE_KEY_BASE58');
    expect(executor.getBotMode()).toBe('stopped');
    expect(process.env.SOLANA_TREASURY_SECRET_KEY).toBeUndefined();
    process.env.SOLANA_TREASURY_SECRET_KEY = fixture;
    expect(() => executor.initializeExecutor()).toThrow('Missing SOLANA_PRIVATE_KEY_BASE58');
    const { getConnection } = require('../routes/solanaTx');
    expect(getConnection).not.toHaveBeenCalled();
  });

  it('loads only the explicit unfunded trading fixture and never logs its material', async () => {
    const trading = Keypair.generate();
    const treasury = Keypair.generate();
    const encoded = bs58.encode(trading.secretKey);
    process.env.SOLANA_PRIVATE_KEY_BASE58 = encoded;
    process.env.SOLANA_TREASURY_SECRET_KEY = bs58.encode(treasury.secretKey);
    const executor = require('../services/SolanaExecutor') as typeof import('../services/SolanaExecutor');
    const { getConnection } = require('../routes/solanaTx');
    const getBalance = jest.fn().mockResolvedValue(0);
    getConnection.mockReturnValue({ getBalance });
    executor.initializeExecutor();
    const balance = await executor.getWalletBalance();
    expect(balance.address).toBe(trading.publicKey.toBase58());
    expect(balance.address).not.toBe(treasury.publicKey.toBase58());
    expect(executor.getKeypairSource()).toBe('SOLANA_PRIVATE_KEY_BASE58');
    const { addLog } = require('../services/SolanaScanner');
    expect(JSON.stringify(addLog.mock.calls)).not.toContain(encoded);
  });

  it('does not expose malformed signer input through decoder errors', () => {
    const input = 'invalid sensitive fixture [unterminated';
    process.env.SOLANA_PRIVATE_KEY_BASE58 = input;
    const { readTradingSigner } = require('../utils/solanaTradingSigner');
    expect(readTradingSigner).toThrow('Invalid SOLANA_PRIVATE_KEY_BASE58 trading signer');
    try { readTradingSigner(); } catch (error) {
      expect(String(error)).not.toContain(input);
    }
  });

  it('does not let treasury diagnostics inherit a trading or legacy arbitrage identity', () => {
    delete process.env.SOLANA_TREASURY_SECRET_KEY;
    const fixture = bs58.encode(Keypair.generate().secretKey);
    process.env.SOLANA_PRIVATE_KEY_BASE58 = fixture;
    process.env.SOLANA_ARB_SECRET_KEY = fixture;
    const { parseTreasuryDiagnostics } = jest.requireActual('../routes/solanaTx') as typeof import('../routes/solanaTx');
    expect(parseTreasuryDiagnostics()).toMatchObject({ configured: false, envVarSeen: false, keypair: null });
  });
});
