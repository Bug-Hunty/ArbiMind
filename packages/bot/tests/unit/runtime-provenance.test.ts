import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertExecutionProvenance, provenanceMatches, readRuntimeProvenance } from '../../src/solana/RuntimeProvenance';
import { assertRequiredNodeVersion, checkRuntimeVersion } from '../../src/RuntimeVersionGuard';
import { publishRuntimeProvenance } from '../../src/solana/ReadinessProducers';
import { SessionMetrics } from '../../src/solana/SessionMetrics';
import { deriveRecommendation } from '../../src/solana/ShadowReport';

const artifact = {
  sourceSha: 'f2b3ff5778ebfafa29adcf4ef6b53a05e246e216',
  buildAtIso: '2026-09-11T00:00:00.000Z',
};
const fakeSha = 'a'.repeat(40);

describe('runtime provenance', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts the authoritative Node version and rejects a different runtime', () => {
    expect(checkRuntimeVersion('v22.23.2', '22.23.2').matches).toBe(true);
    expect(checkRuntimeVersion('v24.14.0', '22.23.2').matches).toBe(false);
    expect(() => assertRequiredNodeVersion('v24.14.0', '22.23.2')).toThrow('refusing to start');
  });

  it.each<[string, NodeJS.ProcessEnv]>([
    ['no environment hints', {}],
    ['all hints confirm the artifact', {
      ARBIMIND_SOURCE_SHA: artifact.sourceSha,
      ARBIMIND_RUNTIME_SHA: artifact.sourceSha,
      GIT_SHA: artifact.sourceSha,
    }],
    ['source hint confirms the artifact', { ARBIMIND_SOURCE_SHA: artifact.sourceSha }],
    ['runtime hint confirms the artifact', { ARBIMIND_RUNTIME_SHA: artifact.sourceSha }],
    ['GIT_SHA confirms the artifact', { GIT_SHA: artifact.sourceSha }],
  ])('accepts %s', (_name, env) => {
    const provenance = readRuntimeProvenance(env, () => artifact);
    expect(provenance.sourceSha).toBe(artifact.sourceSha);
    expect(provenance.runtimeSha).toBe(artifact.sourceSha);
    expect(provenanceMatches(provenance)).toBe(true);
    expect(() => assertExecutionProvenance(provenance, false)).not.toThrow();
    expect(() => assertExecutionProvenance(provenance, true)).not.toThrow();
  });

  it.each<[string, NodeJS.ProcessEnv]>([
    ['equal fake pair', { ARBIMIND_SOURCE_SHA: fakeSha, ARBIMIND_RUNTIME_SHA: fakeSha }],
    ['fake source', { ARBIMIND_SOURCE_SHA: fakeSha }],
    ['fake runtime', { ARBIMIND_RUNTIME_SHA: fakeSha }],
    ['different fake pair', { ARBIMIND_SOURCE_SHA: fakeSha, ARBIMIND_RUNTIME_SHA: 'b'.repeat(40) }],
    ['fake GIT_SHA', { GIT_SHA: fakeSha }],
    ['fake GIT_SHA alongside matching explicit hints', {
      ARBIMIND_SOURCE_SHA: artifact.sourceSha,
      ARBIMIND_RUNTIME_SHA: artifact.sourceSha,
      GIT_SHA: fakeSha,
    }],
    ['empty hint', { ARBIMIND_RUNTIME_SHA: '' }],
  ])('fails closed for %s, including LOG_ONLY and readiness', (_name, env) => {
    const provenance = readRuntimeProvenance(env, () => artifact);
    expect(provenance.sourceSha).toBe(artifact.sourceSha);
    expect(provenance.runtimeSha).toBeNull();
    expect(provenanceMatches(provenance)).toBe(false);
    expect(() => assertExecutionProvenance(provenance, false)).toThrow('refusing to start');
    expect(() => assertExecutionProvenance(provenance, true)).toThrow('refusing to start');

    const metrics = new SessionMetrics();
    publishRuntimeProvenance(metrics, provenance);
    const snapshot = metrics.getShadowSnapshot();
    expect(snapshot.readinessHealth.sourceSha).toBe(artifact.sourceSha);
    expect(snapshot.readinessHealth.runtimeSha).toBeNull();
    expect(deriveRecommendation(snapshot).reasons).toContain('runtime/source SHA provenance is missing or mismatched');
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['array', [artifact]],
    ['missing SHA', {}],
    ['non-string SHA', { sourceSha: 123 }],
    ['short SHA', { sourceSha: 'abc' }],
    ['non-hex SHA', { sourceSha: 'z'.repeat(40) }],
    ['SHA with whitespace', { sourceSha: ` ${artifact.sourceSha}` }],
  ])('rejects a malformed artifact (%s) even with equal environment hints', (_name, built) => {
    const provenance = readRuntimeProvenance({
      ARBIMIND_SOURCE_SHA: artifact.sourceSha, ARBIMIND_RUNTIME_SHA: artifact.sourceSha,
    }, () => built);
    expect(provenance.sourceSha).toBeNull();
    expect(provenance.runtimeSha).toBeNull();
    expect(provenanceMatches(provenance)).toBe(false);
    expect(() => assertExecutionProvenance(provenance, false)).toThrow('refusing to start');
    expect(() => assertExecutionProvenance(provenance, true)).toThrow('refusing to start');
  });

  it('loads the generated artifact at the production-relative path', () => {
    const read = vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(artifact));
    const provenance = readRuntimeProvenance({ ARBIMIND_BUILD_AT: 'operator timestamp' });
    expect(read).toHaveBeenCalledWith(path.resolve(__dirname, '../../src/runtime-provenance.json'), 'utf8');
    expect(provenance.sourceSha).toBe(artifact.sourceSha);
    expect(provenance.buildAtIso).toBe(artifact.buildAtIso);
    expect(provenanceMatches(provenance)).toBe(true);
  });

  it.each(['ENOENT', 'EACCES', 'invalid JSON'])('fails closed when the artifact cannot be loaded: %s', (failure) => {
    const read = vi.spyOn(fs, 'readFileSync');
    if (failure === 'invalid JSON') read.mockReturnValue('{');
    else read.mockImplementation(() => { throw Object.assign(new Error(failure), { code: failure }); });
    const provenance = readRuntimeProvenance({ GIT_SHA: artifact.sourceSha });
    expect(provenance.sourceSha).toBeNull();
    expect(provenanceMatches(provenance)).toBe(false);
    expect(() => assertExecutionProvenance(provenance, false)).toThrow('refusing to start');
    expect(() => assertExecutionProvenance(provenance, true)).toThrow('refusing to start');
  });

  it.each(['valid HEAD', 'Git failure', 'invalid HEAD'])('build generator trusts only Git: %s', (scenario) => {
    const scriptDirectory = path.resolve(__dirname, '../../scripts');
    const script = fs.readFileSync(path.join(scriptDirectory, 'write-runtime-provenance.cjs'), 'utf8');
    const writes = { mkdirSync: vi.fn(), writeFileSync: vi.fn() };
    const execFileSync = vi.fn(() => {
      if (scenario === 'Git failure') throw new Error('Git unavailable');
      return scenario === 'valid HEAD' ? `${artifact.sourceSha}\n` : 'malformed';
    });
    const modules: Record<string, unknown> = { fs: writes, path, child_process: { execFileSync } };
    const generate = () => vm.runInNewContext(script, {
      require: (name: string) => modules[name],
      __dirname: scriptDirectory,
      process: { env: { ARBIMIND_SOURCE_SHA: fakeSha, ARBIMIND_RUNTIME_SHA: fakeSha, GIT_SHA: fakeSha } },
    });
    if (scenario === 'valid HEAD') {
      generate();
      expect(JSON.parse(writes.writeFileSync.mock.calls[0][1]).sourceSha).toBe(artifact.sourceSha);
    } else {
      expect(generate).toThrow();
      expect(writes.writeFileSync).not.toHaveBeenCalled();
    }
    expect(execFileSync).toHaveBeenCalledWith('git', ['-C', path.resolve(scriptDirectory, '../../..'), 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  });
});
