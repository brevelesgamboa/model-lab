# Neural Growth validation status

Recorded October 6, 2026. Engine validation and main-application integration
checks are separate below; neither is universal device or release certification.

## Verified

- All 51 project unit tests passed, including 10 NCA numerical/schema tests,
  8 adapter/capability lifecycle tests, and 6 isolated-server tests.
- Source syntax, existing model integrity, and project lint checks passed.
- The three prototype browser modules passed an additional browser-global lint
  check using the application's rule set.
- Nine standalone browser acceptance checks passed on both Chromium SwiftShader
  and ANGLE OpenGL backed by an AMD Radeon RX 6700 XT.
- The fixed 8 × 8 numerical fixture matched the CPU oracle exactly on SwiftShader
  and within one encoded byte on Radeon. Inactive cells remained exact, repeated
  seeded runs agreed within each backend, and explicit disposal zeroed the
  runtime-owned resource ledger.
- Checks covered pause, single step, disturbance, seed/grid validation, blank
  seed rejection, display-only controls, resize/snapshot immutability,
  transactional load failure, synthetic visibility/BFCache suspension, and
  permanent page disposal.
- Checkpoint extraction reproduced the pinned asset without changing its hash:
  `6e8a5177fb7eb600f6b21f8f888d2a28acf2ad2687f49577ec0aedbee41270de`.

Short-run reports produced during validation:

- Software: `/tmp/latent-field-nca-validation-B8lXzJ/report.json`.
- Hardware: `/tmp/latent-field-nca-validation-etkQnM/report.json`.
- Shared production-engine recheck: `/tmp/latent-field-nca-validation-3lYmS2/report.json`.

Temporary artifacts are machine-local and may be removed by the operating system.

## Extended engine validation: passed

The final report from the 30-minute run was inspected during integration. It
completed successfully at 256 × 256 on ANGLE OpenGL / AMD Radeon RX 6700 XT:

- 54,000 updates, averaging 29.992 updates/second against a requested 30.
- Display RAF intervals: p50/p95 16.7 ms, p99 16.8 ms, maximum 33.2 ms.
- Maximum step burst: one; runtime-owned resource counts unchanged throughout.
- Evolving, nonuniform state; no reported page or console errors.
- Explicit final disposal cleared the runtime-owned resource ledger.

The report finished at `2026-10-06T19:50:35.103Z` and is available locally at
`/tmp/latent-field-nca-validation-PL24jZ/report.json`. This replaces the earlier
"unverified" status; the initial interruption prevented inspection, not completion.
Repeat with:

```sh
node tools/validate-neural-growth.mjs --hardware --grid=256 --soak-minutes=30
```

An earlier six-minute run was deliberately interrupted after a precision fix
and is superseded; it does not satisfy the long-run gate either.

Real browser-tab/BFCache transitions beyond the synthetic lifecycle checks remain
to be tested. No cross-browser, low-end-device, or universal
frame-rate claim has been established. Resource counters estimate owned textures,
not total driver memory, and stable heap samples are not proof of no memory leak.

## Main-application hardware integration

Production build, integrity checks, lint, and all 18 Chromium browser regressions
passed. Seven of those exercise Growth's actual WebGL2 route: immutable PNG,
pause/navigation/model switching, pointer coordinates, seed/grid changes,
download retry, real context-loss recovery, and cancellation during loading.
Existing DigiFace inference, local neural inference, PCA, and Inception gradient,
resume, and full-ascent tests also passed. The full-ascent test retains real
computation and has a larger software-renderer timeout; it completed in about
five minutes on SwiftShader. No Inception computation was changed in this pass.

The integrated app ran for two minutes on the same Radeon device at 256 × 256,
requesting 30 updates/second. It completed 3,601 updates with unchanged tracked
resources and no reported page/console errors. Maximum update burst was one;
draw-submission intervals were p50 16.7 ms, p95 19 ms, and p99 21.5 ms. These
measure app pacing, not GPU kernel timing or a universal frame-rate guarantee.

After pausing, switching to Folded Fractal and back retained all state bytes.
PNG export also retained all state bytes. Report and UI screenshot:
`/tmp/latent-field-growth-app-9OFUH4/`. This short integrated run complements,
but does not replace, the longer engine soak above.

Final layout checks at 360, 900, and 1440 pixels showed no horizontal overflow
or changed update count during resizing. These are desktop Chromium viewport
checks, not physical-phone validation.

## Scope boundary

The integration promotes the tested engine and checkpoint into the normal app
route, production server allowlist, and integrity-checked static build. The
development harness exercises these same files. There was no custom model
training, paid compute, commit, or push. Original visual packs remain out of scope.
