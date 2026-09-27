import fs from 'fs';
import path from 'path';

export interface RuntimeProvenance {
  sourceSha: string | null;
  runtimeSha: string | null;
  nodeVersion: string;
  startedAtIso: string;
  buildAtIso: string | null;
}

function isCommitSha(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

function loadBuildArtifact(): unknown {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'runtime-provenance.json'), 'utf8'));
}

export function readRuntimeProvenance(
  env: NodeJS.ProcessEnv = process.env,
  loadArtifact: () => unknown = loadBuildArtifact,
): RuntimeProvenance {
  let built: Record<string, unknown> = {};
  try {
    const artifact = loadArtifact();
    if (artifact !== null && typeof artifact === 'object' && !Array.isArray(artifact)) {
      built = artifact as Record<string, unknown>;
    }
  } catch {
    // Missing, unreadable or invalid artifacts remain unhealthy; environment cannot repair them.
  }
  const artifactSha = isCommitSha(built['sourceSha']) ? built['sourceSha'] : null;
  const hintsMatch = ['ARBIMIND_SOURCE_SHA', 'ARBIMIND_RUNTIME_SHA', 'GIT_SHA'].every(
    (key) => env[key] === undefined || env[key] === artifactSha,
  );
  return {
    sourceSha: artifactSha,
    // A null runtime identity carries the failure into the existing readiness producer.
    runtimeSha: hintsMatch ? artifactSha : null,
    nodeVersion: process.version,
    startedAtIso: new Date().toISOString(),
    buildAtIso: typeof built['buildAtIso'] === 'string' ? built['buildAtIso'] : null,
  };
}

export function provenanceMatches(provenance: RuntimeProvenance): boolean {
  return Boolean(
    isCommitSha(provenance.sourceSha) &&
    provenance.sourceSha === provenance.runtimeSha,
  );
}

export function assertExecutionProvenance(
  provenance: RuntimeProvenance,
  _logOnly: boolean,
): void {
  // LOG_ONLY also requires authoritative provenance so Baseline evidence is attributable.
  if (!provenanceMatches(provenance)) {
    throw new Error('[PROVENANCE] valid build artifact and matching environment SHA hints required; refusing to start');
  }
}
