# Model adapter contract

Register adapters in `assets/js/core/model-registry.js`. Each adapter supplies `id`, `name`, `family`, `backend`, `description`, `available`, `controls`, and `render(canvas, parameters, timeSeconds)`. Registration validates the control schema and rendering entry point.

Controls are data definitions with a unique `key`, a `label`, a `type` (range, number, or select), and a valid `default`. Numeric controls have finite bounds and a positive step. Select options are objects with `value` and `label`; numeric values retain their type. Optional `help` explains model meaning, not unsupported semantic claims.

The controls controller renders the schema; do not introduce model-specific hardcoded control allowlists. Stored parameters are sanitized against the current schema. Use `normalizeStoredParameter(key, value)` for deliberate migrations.

## Render ownership

Render into a private/offscreen canvas when doing GPU work, then blit to the supplied 2D target. Return backend, modelMetrics, inferenceMs, and an optional status (ready, waiting, processing, cancelled, error). Asynchronous adapters must guard canvas writes after await points with a generation token.

Implement `cancel()` to invalidate in-flight work, `waitForIdle()` for asynchronous compute, and `dispose()` to release owned resources. Internal-clock models implement `setClockRunning(enabled)` and declare `usesInternalClock = true`; ordinary range modulation is then disabled. Individual controls can opt out with `modulation: false`.

The playback controller pauses on navigation/visibility changes without resetting model state. Expensive training, loading, or model replacement must use the application's exclusive compute lease. Do not put async work inside `tf.tidy()`; retain necessary tensors explicitly and dispose them in finally blocks.

## Stateful app-clock simulations

The renderer passes a fourth argument, `{ advanceSimulation }`, to adapters.
Only interactive animation ticks opt in; ordinary redraws and exact captures
pass false. A stateful adapter must not infer stepping from `timeSeconds` alone.
Implement `setClockRunning(enabled)` to rebase timing on resume, retain state on
pause/cancel, and bound catch-up work. Set `supportsModulation = false` and
`supportsRandomize = false` when generic parameter animation is inappropriate.

Declare `captureCapabilities` explicitly: `png`, `gif`, `highResolution`,
`savedRun`. These are independent of `usesInternalClock`; omission retains
existing capture behavior. Stateful PNG adapters expose `renderSnapshot(canvas)`
as a pure draw and declare `statefulSimulation = true`. Do not enable Saved Runs
without real simulation-state serialization or high resolution by relabeling
an enlarged preview as a larger simulation.

## Assets and tests

Model files belong under a dedicated `models/` directory. Record original source, checkpoint/version, conversion procedure, hashes, license, and redistribution restrictions. Add the exact assets to `tools/model-assets.json` and the explicit build allowlist. Generated runtimes are prepared from pinned npm dependencies, not committed.

Add unit tests for schema/migrations and browser tests for actual execution, cancellation, and resource cleanup. GPU-capable metadata must describe supported backends, not imply that a specific physical GPU was selected.
