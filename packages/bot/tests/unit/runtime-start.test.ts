import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const botRoot = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(botRoot, '../..');
const temporaryRoots: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arbimind-runtime-'));
  temporaryRoots.push(root);
  const bot = path.join(root, 'packages/bot');
  for (const directory of ['src', 'scripts', 'dist', 'node_modules']) fs.mkdirSync(path.join(bot, directory), { recursive: true });
  fs.copyFileSync(path.join(botRoot, 'scripts/start.cjs'), path.join(bot, 'scripts/start.cjs'));
  fs.copyFileSync(path.join(repoRoot, '.nvmrc'), path.join(root, '.nvmrc'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@10.27.0' }));
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - packages/*\n");
  const actualPackage = JSON.parse(fs.readFileSync(path.join(botRoot, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(bot, 'package.json'), JSON.stringify({ name: '@arbimind/bot', scripts: { start: actualPackage.scripts.start } }));
  fs.writeFileSync(path.join(bot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', lib: ['ES2022'], module: 'CommonJS', rootDir: 'src', outDir: 'dist', types: [] },
    include: ['src/**/*.ts'],
  }));
  fs.symlinkSync(path.dirname(require.resolve('typescript/package.json')), path.join(bot, 'node_modules/typescript'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(bot, 'dist/index.js'), "console.log('STALE_BOOT_MARKER');\n");
  fs.writeFileSync(path.join(bot, 'dist/deleted-source.js'), "throw new Error('obsolete output');\n");
  return { root, bot };
}

function writeMarker(bot: string, marker: string) {
  // This fixture has no application imports, environment files, wallets or RPC.
  fs.writeFileSync(path.join(bot, 'src/index.ts'), `declare const console: { log(message: string): void };\nconsole.log(${JSON.stringify(marker)});\n`);
}

function start(root: string) {
  const pnpmCli = process.env['npm_execpath'];
  if (!pnpmCli || !/pnpm[^/\\]*\.[cm]?js$/i.test(pnpmCli)) throw new Error('Run this integration test through pnpm test');
  const env: Record<string, string> = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  env['PATH'] = `${path.dirname(process.execPath)}${path.delimiter}${process.env['PATH'] || ''}`;
  env['ARBIMIND_BUILD_GIT_SHA'] = 'a'.repeat(40);
  return spawnSync(process.execPath, [pnpmCli, '--dir', root, '--filter', '@arbimind/bot', 'start'], {
    cwd: root, env, encoding: 'utf8', timeout: 45_000,
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    const resolved = fs.realpathSync(root);
    const expectedParent = fs.realpathSync(os.tmpdir());
    if (path.dirname(resolved) !== expectedParent || !path.basename(resolved).startsWith('arbimind-runtime-')) {
      throw new Error('Unexpected runtime fixture cleanup path');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe('the real bot start command', () => {
  it('runs each new source marker without a manual build and records its provenance', () => {
    const { root, bot } = fixture();
    writeMarker(bot, 'CURRENT_BOOT_MARKER');
    const first = start(root);
    expect(first.status, first.stderr + first.stdout).toBe(0);
    expect(first.stdout).toContain('CURRENT_BOOT_MARKER');
    expect(first.stdout).not.toContain('STALE_BOOT_MARKER');
    expect(fs.existsSync(path.join(bot, 'dist/deleted-source.js'))).toBe(false);
    const firstMetadata = JSON.parse(fs.readFileSync(path.join(bot, 'dist/runtime-provenance.json'), 'utf8'));
    expect(firstMetadata).toMatchObject({ gitSha: 'a'.repeat(40), nodeVersion: process.version });
    expect(firstMetadata.sourceSha).toMatch(/^[a-f0-9]{64}$/);
    expect(firstMetadata.buildSha).toMatch(/^[a-f0-9]{64}$/);
    expect(Number.isFinite(Date.parse(firstMetadata.startupTimestamp))).toBe(true);

    writeMarker(bot, 'UPDATED_BOOT_MARKER');
    const second = start(root);
    expect(second.status, second.stderr + second.stdout).toBe(0);
    expect(second.stdout).toContain('UPDATED_BOOT_MARKER');
    expect(second.stdout).not.toContain('CURRENT_BOOT_MARKER');
    const secondMetadata = JSON.parse(fs.readFileSync(path.join(bot, 'dist/runtime-provenance.json'), 'utf8'));
    expect(secondMetadata.sourceSha).not.toBe(firstMetadata.sourceSha);
    expect(secondMetadata.buildSha).not.toBe(firstMetadata.buildSha);
  }, 100_000);

  it('cannot fall back to old dist after a compilation failure', () => {
    const { root, bot } = fixture();
    fs.writeFileSync(path.join(bot, 'src/index.ts'), 'const invalid: number = ;\n');
    const result = start(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('STALE_BOOT_MARKER');
    expect(result.stdout).not.toContain('[RUNTIME_PROVENANCE]');
    expect(fs.existsSync(path.join(bot, 'dist/index.js'))).toBe(false);
  }, 60_000);

  it('rejects a Node mismatch before building or loading the application', () => {
    const { root, bot } = fixture();
    writeMarker(bot, 'UNREACHABLE_BOOT_MARKER');
    fs.writeFileSync(path.join(root, '.nvmrc'), '0.0.0\n');
    const result = start(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Node runtime mismatch');
    expect(result.stdout).not.toContain('UNREACHABLE_BOOT_MARKER');
    expect(result.stdout).not.toContain('STALE_BOOT_MARKER');
  }, 60_000);
});
