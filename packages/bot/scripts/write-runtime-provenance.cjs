const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..', '..');
let sourceSha = null;
try {
  sourceSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  sourceSha = process.env.ARBIMIND_SOURCE_SHA ?? null;
}

const output = path.resolve(__dirname, '..', 'dist', 'runtime-provenance.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify({ sourceSha, buildAtIso: new Date().toISOString() }, null, 2)}\n`, 'utf8');
