# Organic Structures validation

Device-specific evidence, 2026-10-06: Chromium 153 / ANGLE OpenGL ES 3.2,
AMD Radeon RX 6700 XT (radeonsi navi22 ACO), TensorFlow.js 4.22.0. Seeds do not
promise bit-identical training across graphics drivers or TensorFlow.js versions.

## Released checkpoints

| Pattern | Recipe | Iterations | Final pooled loss | 8,192-update loss range |
| --- | --- | ---: | ---: | ---: |
| Membrane Field | fixed-feature-gram-v1 | 1,200 | 0.00532799 | 0.005013–0.005716 |
| Filament Network | fixed-feature-spatial-v2 | 1,600 | 0.02250567 | 0.028231–0.034848 |

Losses from different recipes are not comparable. The final pooled training loss
is a pre-optimizer batch measurement, not an independent visual-quality score.
Both runs used seed 20261006, random initialization, the same fixed architecture,
and no published weights or pretrained feature extractor.

Each checkpoint was checked independently with the production engine at 128²
and 256² using seeds 1, 17 and 42. Recorded rollout ages: 64, 256, 512, 2,048 and
8,192 updates. Every run then received a centered circular disturbance of radius
0.15 × grid size and 2,048 recovery updates. Rendered before/after frames were
visually inspected. These accelerated rollouts are not a wall-clock 30-minute
soak or proof of stability for every seed/device.

One-step trainer/GPU and numerical-oracle/GPU comparisons used a deterministic
32² state fixture and the runtime's exact update mask. Maximum byte error was 1
for both comparisons and both models. Color variance remained nonzero through
the long rollouts. Handle accounting stayed at 9 textures, 5 framebuffers,
6 programs and 1 VAO; texture-byte accounting was 1,775,340 at 128² and 7,083,756
at 256². All counts reached zero after disposal. This is tracked handle/texture
accounting, not a measurement of total browser heap or driver VRAM.

Post-iteration TensorFlow.js tensor counts remained 69 for v1 and 93 for v2.
The CPU gradient regression checks both learned layers, immutable weight exports,
and return to the baseline tensor count on disposal. WebGL training needs much
more transient memory than inference; the TensorFlow.js allocator can retain a
large reusable texture cache. Do not run multiple training jobs when measuring
performance or on a memory-constrained device.

## Visual limitations

Membrane Field grows connected ridged tissue rather than copying the target's
cavity layout. Filament Network grows finer connected bands with a strong
diagonal bias; its spatial loss drifts during longer rollouts. Both recover a
coherent textured field after disturbance in the inspected runs. Neither is
photorealistic microscopy, a biological simulation, or a perceptual/drug model.

Earlier v1 filament/reef candidates matched some statistics but retained
complementary-color pixel noise. They were excluded from the release catalog.
Only an inspected and independently validated candidate should be added to
`assets/js/models/neural-growth/patterns.js` and the release asset manifest.

## Source integrity

| Target file | SHA-256 |
| --- | --- |
| targets/membrane-field.png | 2c67f4058ebc33ab072124c92548f787ff4f9e964e32b0487f166207f73691a6 |
| targets/filament-network.png | dd48f487f1aecaa647f93d9a1dc6e42428cd17b15122d7d8e02b195265f55cab |
| targets/xeno-reef.png | 0c6c486ba173fff69ce04809a1959d6cac586945a4af73fa24e3637f6a20e5f7 |

Complete built-in generation prompts are in [README.md](README.md). Checkpoint
hashes and byte counts are enforced by `tools/model-assets.json`. The original
pack's training code, source targets and validation material are not shipped to
the app or fetched during ordinary inference.
