import { describe, expect, it } from 'vitest';
import { assertExecutionProvenance, provenanceMatches, readRuntimeProvenance } from '../../src/solana/RuntimeProvenance';

describe('runtime provenance', () => {
  it('accepts matching source and runtime identities', () => {
    const provenance = readRuntimeProvenance({ ARBIMIND_SOURCE_SHA: 'abc', ARBIMIND_RUNTIME_SHA: 'abc' });
    expect(provenanceMatches(provenance)).toBe(true);
    expect(() => assertExecutionProvenance(provenance, false)).not.toThrow();
  });

  it.each([
    { ARBIMIND_SOURCE_SHA: 'abc', ARBIMIND_RUNTIME_SHA: 'def' },
    { ARBIMIND_SOURCE_SHA: 'abc' },
    {},
  ])('rejects execution with missing or mismatched identity', (env) => {
    const provenance = readRuntimeProvenance(env);
    expect(provenanceMatches(provenance)).toBe(false);
    expect(() => assertExecutionProvenance(provenance, false)).toThrow();
    expect(() => assertExecutionProvenance(provenance, true)).not.toThrow();
  });
});
