export interface RuntimeProvenance {
  sourceSha: string | null;
  runtimeSha: string | null;
  nodeVersion: string;
  startedAtIso: string;
  buildAtIso: string | null;
}

export function readRuntimeProvenance(env: NodeJS.ProcessEnv = process.env): RuntimeProvenance {
  return {
    sourceSha: env['ARBIMIND_SOURCE_SHA'] ?? env['GIT_SHA'] ?? null,
    runtimeSha: env['ARBIMIND_RUNTIME_SHA'] ?? env['GIT_SHA'] ?? null,
    nodeVersion: process.version,
    startedAtIso: new Date().toISOString(),
    buildAtIso: env['ARBIMIND_BUILD_AT'] ?? null,
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
