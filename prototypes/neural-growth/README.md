# Neural Growth prototype

A development-only feasibility test for one pretrained Texture Neural Cellular
Automaton (NCA). It evolves a persistent 12-channel cell grid using a learned
local update rule. The selected reference checkpoint produces vesicle-like
structures; it is not an original Latent Field checkpoint or a biological model.

Neural Growth is now registered in the main application. This standalone harness
shares its production engine in `assets/js/models/neural-growth/` and checkpoint
in `models/neural-growth/`; the harness itself is not copied into `dist`.

## Run

From the repository root, with Node.js 24+ and the project's dependencies installed:

```sh
node tools/neural-growth-server.mjs
```

Open <http://127.0.0.1:8081>. Set `NEURAL_GROWTH_PORT` to choose a different local
port. The dedicated server exposes only the prototype's explicit file allowlist;
it does not expose the rest of the workspace.

The included checkpoint is approximately 75 KiB. Users do not train a model,
upload executable files, or download Inception to run this prototype. Runtime
inference uses native WebGL2 RGBA8 targets without another JavaScript dependency.

## Controls and state

- **Play / pause and single step:** advance or freeze the current cell state.
- **Restart and initialization seed:** reset deliberately. The seed controls the
  stochastic update schedule, not a separate random image generator.
- **Simulation grid:** choose 128 × 128 or 256 × 256; changing it restarts the
  simulation after successful allocation.
- **Growth speed:** requested updates per second, with at most two updates per
  display frame. Excess elapsed time is discarded rather than accumulated.
- **Display palette:** native checkpoint colors or a display-only spectral map.
  Neither palette nor speed changes reinitialize the simulation.
- **Disturb:** clear a local circle across all hidden and visible channels.
  Click or drag the canvas, or use the center-disturbance button.
- **PNG snapshot:** capture without advancing the simulation. The display is
  upscaled from the selected grid; the PNG is not a higher-resolution simulation.

Resizing changes presentation only. Hidden tabs stop stepping; resuming starts
with a fresh clock baseline. Failed checkpoint replacements retain the previous
state and image. BFCache suspension preserves committed state; permanent page
disposal releases the runtime's GPU resources.

## Validate

Install the project's matching Playwright Chromium if it is not already available:

```sh
npx playwright install chromium
npm test
npm run check
node tools/validate-neural-growth.mjs
node tools/validate-neural-growth.mjs --hardware --grid=256 --soak-minutes=30
```

The standalone runner serves its own local instance, checks numerical behavior
against a small CPU oracle, exercises controls and disposal, and benchmarks both
grid sizes. It prints the temporary artifact directory containing `report.json`,
screenshots, and long-run telemetry. An optional `--output=/absolute/path` sets
the artifact directory. Browser dependencies may additionally be needed on
systems unsupported by Playwright.

`--hardware` requests OpenGL-backed ANGLE and rejects a renderer identifying
itself as software. Renderer names are evidence, not a guarantee of hardware
acceleration on every platform. Benchmarks synchronize with full-state readbacks
and include their CPU/copy overhead; they are not pure GPU kernel timings.
Tracked texture counts and estimated storage are not measurements of total VRAM.

Fixed spatial filters accumulate encoded bytes with an explicit nearest/half-up
tie policy. Dense stages retain the exported RGBA8 arithmetic. Tests allow one
encoded byte of final-state rounding difference and require inactive cells to
remain exact; they do not promise cross-device bitwise identity.

## Provenance and next decision

See [NOTICE.md](../../models/neural-growth/NOTICE.md) for the checkpoint's **CC-BY-4.0** attribution,
the **Apache-2.0** runtime reference, pinned sources, hashes, numerical conventions,
and checkpoint regeneration instructions. These terms are separate from the
project's MIT license.

This pass does not include image conditioning, original pattern training, model
imports, saved simulation checkpoints, or GIF capture. Original
visual packs and any new environmental conditioning need their own design and
training validation before being described as product features.
