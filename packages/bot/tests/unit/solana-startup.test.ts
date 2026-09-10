import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const botRoot = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(botRoot, '../..');
beforeAll(async () => {
  await Promise.all([import('ethers'), import('viem/chains'), import('winston')]);
}, 60_000);
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('Solana-only startup independence', () => {
  /*
   * DROPPED during the PR #8 rebase (see PR8-REBASE-DECISIONS.md):
   *   'does not require EVM RPC, wallet or venue configuration when its scanner is disabled'
   *   'still requires an EVM RPC when the EVM scanner is enabled'
   *     -> already covered, more strongly, by startup-isolation.test.ts
   *   'ignores invalid disabled Ethereum venue placeholders while keeping enabled venues'
   *     -> CONTRADICTS D11: main validates every non-empty DEX address whether or
   *        not the venue is enabled, and its tests assert that fail-loud contract.
   * Only the unique exit-status coverage below is retained.
   */

  /**
   * D15. This previously invoked the repository's REAL scripts/start.cjs, which
   * resolves its own distRoot and does `fs.rmSync(distRoot)` before recompiling.
   * Because packages/bot/dist is tracked, the test mutated tracked repository
   * state as a side effect while still passing -- the assertion surface did not
   * include repository cleanliness. Setting the subprocess `cwd` does not
   * sandbox that, since start.cjs derives its paths from __dirname.
   *
   * It now builds an isolated fixture and runs a COPY of start.cjs there, the
   * same isolation model as runtime-start.test.ts. Unlike that fixture, this one
   * carries the real `src` so startup reaches real configuration validation.
   */
  function startupFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arbimind-startup-'));
    const bot = path.join(root, 'packages/bot');
    fs.mkdirSync(path.join(bot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(botRoot, 'src'), path.join(bot, 'src'), { recursive: true });
    fs.copyFileSync(path.join(botRoot, 'scripts/start.cjs'), path.join(bot, 'scripts/start.cjs'));
    fs.copyFileSync(path.join(botRoot, 'tsconfig.json'), path.join(bot, 'tsconfig.json'));
    fs.copyFileSync(path.join(repoRoot, '.nvmrc'), path.join(root, '.nvmrc'));
    const actualPackage = JSON.parse(fs.readFileSync(path.join(botRoot, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(bot, 'package.json'), JSON.stringify({
      name: '@arbimind/bot', type: actualPackage.type, scripts: { start: actualPackage.scripts.start },
    }));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true }));
    // Resolution only; never written to.
    const link = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(path.join(botRoot, 'node_modules'), path.join(bot, 'node_modules'), link);
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), link);
    return { root, bot };
  }

  it('returns a nonzero exit status for a fatal LOG_ONLY startup without making an RPC call', () => {
    const { root, bot } = startupFixture();
    const env: Record<string, string> = {
      LOG_ONLY: 'true', SOLANA_LOG_ONLY: 'true', SOLANA_TRADING_ENABLED: 'false',
      SOLANA_SCANNER_ENABLED: 'false', EVM_SCANNER_ENABLED: 'true',
      EVM_CHAIN: 'arbitrum', NETWORK: 'mainnet',
      // The fixture is not a Git repository, so start.cjs takes the documented
      // image-build path for source identity.
      ARBIMIND_BUILD_GIT_SHA: 'a'.repeat(40),
    };
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'PATHEXT']) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    try {
      // The COPY inside the fixture. Missing EVM RPC fails validation after
      // provenance passes, so the exit status reflects the intended failure.
      const result = spawnSync(process.execPath, [path.join(bot, 'scripts/start.cjs')], {
        cwd: root, env, encoding: 'utf8', timeout: 240_000,
      });
      expect(result.status, `${result.stdout}
${result.stderr}`).toBe(1);
      expect(result.stderr).toContain('[FATAL] bot startup error');
      expect(result.stderr).toContain('Missing required configuration: ethereumRpcUrl');
    } finally {
      const resolved = fs.realpathSync(root);
      if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('arbimind-startup-')) {
        throw new Error('Unexpected startup fixture path');
      }
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 300_000);
});
