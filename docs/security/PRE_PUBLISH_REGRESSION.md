# Local pre-publish regression

Run this before pushing a release head. It exists because CI is not a superset
of what runs locally: each workflow lints a different workspace, so a gate can
be green locally and red on the exact published head.

Node comes from `.nvmrc` (22.23.2). A fresh shell may resolve a different
system Node; activate the pinned one first.

## The gate

| # | Command | Accept |
|---|---|---|
| 1 | `pnpm run lint:bot` | **0 errors** (warnings may remain — report them) |
| 2 | `pnpm run typecheck` | exit 0 (backend, bot, ui) |
| 3 | `python3 tests/test_assert_required_checks.py` | all pass |
| 4 | `python3 tests/test_audit_surface_gate.py` | all pass |
| 5 | `pnpm audit --prod --json > audit-prod.json` then `python3 scripts/audit_surface_gate.py audit-prod.json --baseline security/audit-baseline.json` | exit 0 |
| 6 | `pnpm --filter @arbimind/bot run test` | run **twice**, identical totals |
| 7 | Gitleaks over archived HEAD, the proposed history and the index | 0 / 0 / 0 |
| 8 | `git status --porcelain` | **empty** |

## Why bot lint is step 1

`bot-tests.yml` runs `Lint bot code` *before* `Run bot tests`, so a single lint
error fails the whole required check and the tests never execute — the job
reports failure having proved nothing about the tests.

Nothing else covers it. `ci.yml` lints the **ui** workspace only, by design
("only UI lint is currently clean on main"). The bot suite passing locally says
nothing about bot lint. A release head was published red for exactly this
reason: an unused local in `Executor.ts` failed `Lint bot code`, and the first
signal was the exact-head CI run.

Do not reach for `lint:ts`: it chains backend lint, which currently has
pre-existing errors and is gated by no workflow. Fixing that is its own change.
Suppressing a finding to make this gate green defeats the gate.

## Warnings

Warnings do not fail the gate, but state the count when reporting a run rather
than saying "lint clean". The bot package currently carries a set of
`@typescript-eslint/naming-convention` warnings that predate this document.

## After the gate

Local success is not publication evidence. The required-check assertion on the
exact published head is — see [REQUIRED_CHECK_EVIDENCE.md](./REQUIRED_CHECK_EVIDENCE.md).
