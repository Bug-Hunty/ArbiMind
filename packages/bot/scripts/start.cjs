'use strict';

// Start always compiles the current source. No package-manager prestart hook or
// pre-existing dist directory is trusted, and no application/env module loads
// until runtime and source/build provenance have been checked.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const botRoot = fs.realpathSync(path.resolve(__dirname, '..'));
const repoRoot = path.resolve(botRoot, '..', '..');
const distRoot = path.join(botRoot, 'dist');

function hashPaths(entries) {
  const hash = createHash('sha256');
  function visit(relativeName, absoluteName) {
    const stat = fs.lstatSync(absoluteName);
    if (stat.isSymbolicLink()) throw new Error('Build inputs and outputs must not be symbolic links');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absoluteName).sort()) {
        visit(`${relativeName}/${name}`, path.join(absoluteName, name));
      }
    } else if (stat.isFile()) {
      const bytes = fs.readFileSync(absoluteName);
      hash.update(`${relativeName}\0${bytes.length}\0`);
      hash.update(bytes);
    } else {
      throw new Error('Unsupported file in build identity');
    }
  }
  for (const [name, absoluteName] of entries) visit(name, absoluteName);
  return hash.digest('hex');
}

function sourceIdentity() {
  const inputs = [
    ['.nvmrc', path.join(repoRoot, '.nvmrc')],
    ['package.json', path.join(botRoot, 'package.json')],
    ['tsconfig.json', path.join(botRoot, 'tsconfig.json')],
    ['scripts', path.join(botRoot, 'scripts')],
    ['src', path.join(botRoot, 'src')],
  ];
  const lockfile = path.join(repoRoot, 'pnpm-lock.yaml');
  if (fs.existsSync(lockfile)) inputs.push(['pnpm-lock.yaml', lockfile]);
  return hashPaths(inputs);
}

function gitIdentity() {
  const commit = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const sha = commit.status === 0 ? commit.stdout.trim() : (process.env.ARBIMIND_BUILD_GIT_SHA || '').trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('Git provenance unavailable: provide the source commit through ARBIMIND_BUILD_GIT_SHA when building an image');
  }
  const status = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' });
  return { gitSha: sha, worktreeDirty: status.status === 0 ? status.stdout.trim().length > 0 : null };
}

function main() {
  const expectedNode = fs.readFileSync(path.join(repoRoot, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(expectedNode) || process.versions.node !== expectedNode) {
    throw new Error(`Node runtime mismatch: expected ${expectedNode} from .nvmrc, received ${process.versions.node}`);
  }

  const git = gitIdentity();
  const sourceSha = sourceIdentity();
  // Both parent and destination are fixed, resolved paths under this package.
  // Refuse a redirected dist before removing regenerable compiler output.
  if (path.dirname(distRoot) !== botRoot || path.basename(distRoot) !== 'dist') {
    throw new Error('Invalid compiler output directory');
  }
  if (fs.existsSync(distRoot) && fs.lstatSync(distRoot).isSymbolicLink()) {
    throw new Error('Refusing a symbolic-link dist directory');
  }
  fs.rmSync(distRoot, { recursive: true, force: true });
  const compiler = require.resolve('typescript/bin/tsc', { paths: [botRoot] });
  execFileSync(process.execPath, [compiler, '--project', path.join(botRoot, 'tsconfig.json'), '--noEmitOnError', '--incremental', 'false'], {
    cwd: botRoot,
    stdio: 'inherit',
  });

  if (sourceIdentity() !== sourceSha) throw new Error('Source changed during compilation; refusing startup');
  const provenance = {
    ...git,
    sourceSha,
    buildSha: hashPaths([['dist', distRoot]]),
    nodeVersion: process.version,
    startupTimestamp: new Date().toISOString(),
    pid: process.pid,
  };
  fs.writeFileSync(path.join(distRoot, 'runtime-provenance.json'), `${JSON.stringify(provenance)}\n`);
  console.log('[RUNTIME_PROVENANCE]', JSON.stringify(provenance));
  require(path.join(distRoot, 'index.js'));
}

try {
  main();
} catch (error) {
  console.error('[STARTUP_FAILED]', error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
}
