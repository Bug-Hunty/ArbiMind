# Solana runtime and signer prerequisites

Upstream issues #405 and #406 are hard prerequisites before **any** canary.
This change prepares their safeguards; it does not authorize live execution.

`pnpm --filter @arbimind/bot start` invokes one launcher that checks the exact
`.nvmrc` version, removes obsolete compiler output, builds current source with
`noEmitOnError`, verifies source identity remained unchanged during compilation,
and loads the new output in the same process. Compile failure never falls back
to old output. A redirected `dist` or build input is rejected. Provenance records
Git SHA, dirty-worktree status, source/build hashes, Node version, timestamp and
PID before application imports. A dirty tree is identifiable, not suitable
evidence for the final baseline: that must start from verified, clean main.

The launcher requires Git provenance. Container builds provide it using
`pnpm --filter @arbimind/bot image:build`, which reads `.nvmrc` and `git rev-parse`
and passes `NODE_VERSION` and `GIT_SHA` to Docker. Direct Docker builds require
both arguments. No image was built or deployed during validation of this patch.

`SOLANA_PRIVATE_KEY_BASE58` is the only trading signer input. The shared parser
accepts the documented encodings but never consults treasury, corrupted or legacy
variables. Missing/invalid credentials fail execution-capable startup before
RPC fallback can mask the problem. Parser errors never include input material.
Shadow mode does not require parsing a private key to validate configuration.

The backend's separate devnet executor also uses only the explicit base58 trading
input. It no longer initializes from treasury keys or mutates treasury env vars.
Treasury withdrawal diagnostics read only their explicit treasury variable and
cannot inherit a legacy arbitrage key. This changes code, not stored credentials.

Both scanner funding paths are gated as well: LOG_ONLY cannot start the inventory
rebalance timer or invoke the per-scan funding/rebalance operation. This matters
because those operations can execute outside the swap executor's LOG_ONLY guard.

Solana-only startup skips disabled EVM venue validation and EVM bot construction.
Fatal startup returns a nonzero exit code in every mode. Env-sensitive tests
restore `process.env` in place; external SDK loading belongs to bounded setup,
while config imports still occur after each test's environment changes.

Validation includes a real start-command fixture whose source marker changes
without a manual build, obsolete-output deletion, compilation failure, wrong
Node, explicit signer/treasury isolation, fatal LOG_ONLY startup, and negative
scanner funding tests with positive controls. All wallets are generated unfunded
fixtures; transaction methods are mocked. No live process or transaction is used.

These are necessary safeguards, not a complete live safety contract. Fee and pool
availability, statistical evidence, explicit caps/circuit breakers, reconciliation,
and a fresh continuous 24-hour shadow baseline remain separate prerequisites.
