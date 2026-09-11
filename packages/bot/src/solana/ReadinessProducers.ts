import type { RuntimeProvenance } from './RuntimeProvenance';
import type { SessionMetrics } from './SessionMetrics';

export interface PoolResolutionResult {
  configured: number;
  resolved: number;
}

export function publishRuntimeProvenance(metrics: SessionMetrics, provenance: RuntimeProvenance): void {
  metrics.publishReadinessProvenance(provenance.sourceSha, provenance.runtimeSha);
}

export function publishSafetyConfiguration(metrics: SessionMetrics, valid: boolean): void {
  metrics.publishSafetyConfiguration(valid);
}

export function publishPoolResolution(metrics: SessionMetrics, result: PoolResolutionResult): void {
  metrics.publishPoolResolution(result.configured, result.resolved);
}
