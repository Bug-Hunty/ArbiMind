# `effectiveConfidence` is not model confidence

Two production gates read a value called `effectiveConfidence`. The name, and
the environment variables around it (`AI_MIN_SUCCESS_PROB`,
`SOLANA_MIN_EXECUTION_CONFIDENCE`), all suggest a learned probability from the
AI scorer. It is not one. It is arithmetic on the net edge.

This document exists so the next person tuning "the confidence threshold"
knows they are tuning an economic edge policy, and so future ML work does not
build on a false assumption.

## The actual mapping

[`Scanner.ts`](../packages/bot/src/solana/Scanner.ts) computes:

```ts
const effectiveConfidence = this.clamp(0.5 + Math.abs(netEdgeBps) / ARB_CONFIDENCE_BPS_SCALE);
```

`ARB_CONFIDENCE_BPS_SCALE` is `SOLANA_ARB_CONFIDENCE_BPS_SCALE`, default **300**.
`clamp` bounds to `[0, 1]`.

The transform is deterministic and invertible, so every "confidence" threshold
is exactly a net-edge threshold:

| `effectiveConfidence` | net edge | scanner gross spread (approx. cost 17 bps) |
| --- | --- | --- |
| 0.70 | ≥ 60 bps | ≥ 77 bps |
| 0.85 | ≥ 105 bps | ≥ 122 bps |
| 1.00 (clamped) | ≥ 150 bps | ≥ 167 bps |

The 17 bps is the scanner's own fixed approximation,
`ARB_SLIPPAGE_BPS (10) + ARB_FEE_BPS (5) + ARB_HAIRCUT_BPS (2)`. It is **not**
the production execution cost, which comes from `ExecutionFeeBudget` and moves
with SOL price, priority fee and notional.

## Both gates consume the same value

| # | Location | Condition | Effective value |
| --- | --- | --- | --- |
| 1 | `Scanner.ts` (`scanPool`) | `effectiveConfidence > config.aiMinSuccessProb` | 0.70 |
| 2 | `Scanner.ts` (`buildSwapOpportunity`) | `confidence < Math.max(aiMinSuccessProb, SOLANA_MIN_EXECUTION_CONFIDENCE)` → reject | 0.85 |

This is not defence in depth across two signals. Both filter the same derived
number, and because gate 2 takes `Math.max` of the two settings, the 0.70 is
strictly subsumed: nothing can pass 0.85 without having passed 0.70. The 0.70
only becomes load-bearing if `SOLANA_MIN_EXECUTION_CONFIDENCE` is ever set
below it.

Gate 2 lives in the scanner despite its name. There is no confidence gate in
`Executor.ts`.

## The AI score has no execution authority

`AiScoringService` is called for every scanned pool, and a missing score
aborts the scan — the score is **required to exist**. Its value never enters
either gate. `SessionMetrics` already says so:

> Note `actionable` and `belowConfidence` describe the *scorer's own verdict*.
> The scanner's execution decision is currently derived from net edge, not from
> the score, so these are observational rather than gating.

Two consequences that have caused misreadings:

- `ai.belowConfidence` is **not** scanner-rejection evidence. It counts the
  scorer declining to recommend EXECUTE, at a boundary production does not use.
- `discovered` increments *after* gate 2, so it counts opportunities that
  survived the gates, not market observations seen. `discovered: 0` alongside
  `ai.requested: 366` is coherent, not contradictory.

A separate, unrelated defect in the scorer's own EXECUTE condition is recorded
in [SCORER_EXECUTE_UNREACHABLE.md](./SCORER_EXECUTE_UNREACHABLE.md).

## What the one observed window showed

From the 2026-09-14 shadow run (33 minutes, SOL/USDC, two pools, 165 seconds
with a comparable pair):

```
gross spread bps:     median 24.22   p90 46.04   max 71.75
effectiveConfidence:  median 0.5241  p90 0.5968  max 0.6825
observations ≥ 0.70:  0 / 165
observations ≥ 0.85:  0 / 165
```

**Read this precisely.** In that window the policy was *observationally
unreachable* — the sample never produced a value that cleared even the lower
gate. That is not the same claim as designed-unreachable, and this document
does not make the stronger claim. One 33-minute window on one pair with two
pools cannot establish what normal SOL/USDC regimes do. Establishing whether
0.85 is incompatible with ordinary regimes requires a broader live sample
evaluated against real production economics.

By contrast, the scorer's `execute > 0.8` condition *is* mathematically
unreachable under the current fallback; that claim rests on a proof from the
formula, not on absence in a sample. See the companion document.

## Rules for future work

- Do not treat `effectiveConfidence` as a learned probability, a calibration
  target, or anything with a meaningful reliability diagram. Correlating it
  against net edge returns ~1.0 by construction, which is a tautology, not
  evidence of calibration.
- Express threshold changes in **bps of net edge**, then convert if a runtime
  setting must be written in the legacy units.
- `SOLANA_ARB_CONFIDENCE_BPS_SCALE` is as load-bearing as the thresholds: it
  decides what edge each "confidence" denotes. Changing 300 silently re-prices
  every threshold in the system.
- If genuine ML scoring is introduced later, give it its own field name. Do not
  reuse `effectiveConfidence`, and do not let a learned score and this
  arithmetic share a threshold.

The terminology is legacy and misleading, and should eventually be replaced by
an explicit economic-edge policy. That rename is deliberately **not** part of
this phase: nothing here changes production field names or behaviour.
