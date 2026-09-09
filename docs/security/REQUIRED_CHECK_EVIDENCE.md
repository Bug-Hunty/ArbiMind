# Required Actions evidence

`scripts/assert_required_checks.py` requires the latest pull-request workflow
run on the exact `HEAD_SHA`. It identifies each job by workflow file and job
name, requires a successful workflow and job, and verifies that the named test,
build, audit and security-analysis steps executed successfully. Missing jobs,
empty steps, skipped/neutral outcomes, older SHAs and older attempts fail.
Rerun **all jobs** of a failed workflow so the evidence belongs to one attempt.

The policy covers CI (including the audit, all workspace tests/types/build and
PowerShell tests), Bot Tests, Bot Typecheck / Build, Gitleaks, and both CodeQL
workflows. The assertion itself has regression tests and does not depend on
package installation. Required workflows run on every PR; path-filtered jobs
cannot satisfy an unconditional requirement when their workflow is omitted.

This prevents a reproduced failure on `6b7cfd2`: `Bot Tests / test` succeeded
while `CI / test` failed its production audit. The old assertion matched the
bare name `test` and incorrectly passed. Its old completion-time sort could
also prefer an old success over a newly queued run.

Run locally with `REPO`, `HEAD_SHA` and optionally `TIMEOUT_MINUTES=0` in the
environment. Local unit-test success does not substitute for this API evidence.
The workflow token requires `actions: read` to inspect run attempts and steps.

Node setup reads `.nvmrc`; Action major versions are unchanged. Deployment and
production-smoke workflows are disabled in `Bug-Hunty/ArbiMind` during this
readiness stage. Re-enabling them is a separate operational decision.
