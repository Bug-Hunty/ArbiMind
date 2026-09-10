'use strict';

// Derive both image runtime and source provenance from this checkout.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const version = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid .nvmrc');
const gitSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(gitSha)) throw new Error('Git provenance unavailable');
execFileSync('docker', ['build', '--build-arg', `NODE_VERSION=${version}`, '--build-arg', `GIT_SHA=${gitSha}`,
  '-f', 'packages/bot/Dockerfile', '-t', `arbimind-bot:${gitSha}`, '.'], { cwd: root, stdio: 'inherit' });
