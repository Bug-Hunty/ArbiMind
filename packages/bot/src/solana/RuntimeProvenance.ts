import fs from 'fs';
import path from 'path';

export interface RuntimeProvenance {
  sourceSha: string | null;
  runtimeSha: string | null;
  nodeVersion: string;
  startedAtIso: string;
  buildAtIso: string | null;
}

export function readRuntimeProvenance(env: NodeJS.ProcessEnv = process.env): RuntimeProvenance {
  let built: { sourceSha?: string | null; buildAtIso?: string | null } = {};
  try {
    built = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'runtime-provenance.json'), 'utf8')) as typeof built;
  } catch {
    // Source-only/dev execution may not have a generated build artifact.
  }
  return {
    sourceSha: env['ARBIMIND_SOURCE_SHA'] ?? env['GIT_SHA'] ?? built.sourceSha ?? null,
    runtimeSha: env['ARBIMIND_RUNTIME_SHA'] ?? env['GIT_SHA'] ?? built.sourceSha ?? null,
    nodeVersion: process.version,
    startedAtIso: new Date().toISOString(),
    buildAtIso: env['ARBIMIND_BUILD_AT'] ?? built.buildAtIso ?? null,
  };
}

export function provenanceMatches(provenance: RuntimeProvenance): boolean {
  return Boolean(
    provenance.sourceSha &&
    provenance.runtimeSha &&
    provenance.sourceSha === provenance.runtimeSha,
  );
}

export function assertExecutionProvenance(
  provenance: RuntimeProvenance,
  logOnly: boolean,
): void {
  if (!logOnly && !provenanceMatches(provenance)) {
    throw new Error('[SOLANA] execution requires matching source/runtime provenance');
  }
}
