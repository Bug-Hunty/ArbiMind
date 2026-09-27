# SCORER_EXECUTE_UNREACHABLE

**Status:** open defect, documented only. Deliberately **not** fixed in the
economic-edge calibration phase.

The bundled AI scorer can never recommend EXECUTE. This is a proof from the
production arithmetic, not an inference from a sample: the fallback path's
confidence has a hard ceiling below the threshold that gates EXECUTE.

## Evidence

**Configuration in use**

```
AI_SCORING_MODE=local            # .env.local
expected model path:  <cwd>/models/predictor/model.json
model present:        NO         # absent at repo root and packages/bot
```

The only tracked `model.json` is `packages/backend/models/arb-predictor/model.json`
— a different path, loaded by the backend, never by the bot's predictor.

**Resulting behaviour**

`predictOpportunity` in [`predictor.ts`](../packages/bot/src/ai/predictor.ts)
checks `fs.existsSync(MODEL_PATH)` and, finding nothing, always takes the
rule-based fallback.

**Fallback arithmetic, as it runs in production**

```ts
score  = Math.min(delta * 100, 30)      // delta cap 30
       + Math.min(liq / 5e6, 20)        // liquidity cap 20
       + Math.min(vol * 50, 15)         // volatility cap 15
       + ((sentiment + 1) / 2) * 10;    // sentiment cap 10
confidence = clamp(score / 75, 0, 1);
execute    = confidence > 0.8;
```

**Hardcoded features at the call site**

`AiScoringService.scoreLocally` builds
`features = [Math.abs(profitPct) / 100, liquidityUsd ?? 0, 0.02, 0]`.
Volatility and sentiment are not available there, so they are passed as
constants:

| feature | value | contribution | of possible |
| --- | --- | --- | --- |
| volatility | `0.02` (constant) | `min(0.02 * 50, 15)` = **1** | 15 |
| sentiment | `0` (constant) | `((0 + 1) / 2) * 10` = **5** | 10 |

Those two terms are pinned at 6 of a possible 25 and cannot vary at runtime.

**The ceiling**

```
max score      = 30 (delta) + 20 (liquidity) + 1 (volatility) + 5 (sentiment) = 56
max confidence = 56 / 75 = 0.7467
EXECUTE needs  = confidence > 0.8
```

`0.7467 < 0.8`, so **EXECUTE is mathematically unreachable** while the model
file is absent. No market condition changes this: `delta` and `liquidity` are
already at their caps in that bound.

## Consequences

- `recommendation === 'EXECUTE'` can never occur under the fallback.
- `SessionMetrics.ai.actionable` therefore cannot become positive through this
  path. The 2026-09-14 shadow run's `actionable: 0, belowConfidence: 366` is
  fully explained by this ceiling, and is **not** evidence about the market.
- `ai.belowConfidence` counts the scorer declining, at a boundary production
  does not gate on.

## This does not block execution

The AI score has no execution authority today. Both production gates consume
`effectiveConfidence`, which is arithmetic on net edge and unrelated to this
scorer — see
[EFFECTIVE_CONFIDENCE_IS_NOT_ML.md](./EFFECTIVE_CONFIDENCE_IS_NOT_ML.md).

The score is nonetheless **required to exist**: a scan aborts when no score is
produced. So this defect is latent today but would become load-bearing the
moment the score is given any authority.

## Out of scope here

Do not, as part of economic-edge calibration, modify:

- `AiScoringService`
- `predictor.ts`
- `MODEL_PATH`
- the fallback scoring formula
- the `execute > 0.8` condition

Fixing it is its own change with its own evidence. Note that the fix is a real
decision, not a constant tweak: raising the ceiling, lowering the threshold,
supplying a model artefact, and feeding real volatility/sentiment are four
different repairs with different consequences, and picking one by whichever
makes `actionable` go positive would repeat the mistake this repository keeps
paying for.
