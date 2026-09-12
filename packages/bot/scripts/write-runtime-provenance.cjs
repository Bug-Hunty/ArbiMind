const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..', '..');
const sourceSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(sourceSha)) {
  throw new Error('Cannot generate runtime provenance: git HEAD is not a valid commit SHA');
}

const output = path.resolve(__dirname, '..', 'dist', 'runtime-provenance.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify({ sourceSha, buildAtIso: new Date().toISOString() }, null, 2)}\n`, 'utf8');
