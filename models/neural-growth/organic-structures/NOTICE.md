# Organic Structures — original Neural Growth patterns

These checkpoints use newly trained dense weights, initialized from scratch.
They are not recolorings, renamed copies, or fine-tuned versions of the published
Vesicle Study checkpoint. Original checkpoint files are supplied under the
project's MIT terms. The adapted runtime retains its Apache-2.0 notice and license;
the separate published reference remains CC-BY-4.0. See
[`../NOTICE.md`](../NOTICE.md) for architecture/runtime attribution.

Training targets are original AI-generated imagined biological/alien textures,
created with the built-in image-generation tool on 2026-10-06. They are not
microscopy data, biological simulations, or models of drug effects or human
perception. Their source images and complete generation prompts are retained in
`prototypes/neural-growth/training/` in the source repository, outside the
application build.

## Training and inference

The development-only TensorFlow.js trainer uses the production 12→48→96→12
architecture with periodic identity/Sobel/Laplacian perception, translated
half-grid updates, RGBA8 quantization, and straight-through rounding gradients.
No pretrained image network, outside training dataset, or published checkpoint
is loaded. The objective matches multiscale Gram statistics of a seeded frozen
random convolution bank, plus RGB means/second moments. This is an original
fixed-feature objective, **not** the published VGG training objective.

Training uses Adam (0.001), a 32-state pool, batch size 2, random 24–40-step
unrolls, periodic blank-state replacement and toroidal circular damage, 32²
training grids, a 128² target, and weight scales [4, 2]. The seed is 20261006.
Browser inference uses only the selected quantized checkpoint and existing
native WebGL2 engine. No end-user training or source-target download is required.

Texture synthesis matches statistical appearance rather than the exact source
composition; it can settle into ridges, loops or other emergent forms. The pack
does not promise photorealistic reproduction of the target images.

## Membrane Field

Trained for 1,200 iterations from scratch on an AMD Radeon RX 6700 XT using
TensorFlow.js 4.22.0 / Chromium 153. Final pooled training loss: 0.00532799.
Independent production-engine validation covered seeds 1, 17 and 42, both 128²
and 256² grids, and rollouts through 8,192 updates with subsequent circular
damage and 2,048 recovery updates. One-step GPU/oracle and trainer/GPU maximum
differences were one byte. Resource-handle counts and texture-byte accounting
were unchanged during each rollout and reached zero on disposal. These are
device-specific checks, not a universal GPU-memory or cross-browser guarantee.

The first release emphasizes luminous ridged tissue and connected boundaries;
it is less cavity-like than its source target. The source and training recipe
remain available for further refinement.

## Filament Network

Trained for 1,600 iterations from scratch with the spatial-v2 objective. This
adds RGB cross-channel Gram statistics and horizontal/vertical neighbor
differences at all four scales, with stronger normalization for these terms.
Seed, architecture, optimizer, state pool and target resolution match Membrane
Field. Final pooled training loss: 0.02250567 (not comparable to the v1 loss).

Validation covered seeds 1, 17 and 42, 128²/256² grids, 8,192-update rollouts and
2,048 recovery updates after damage. Trainer/GPU and GPU/oracle differences were
at most one byte; allocation counts remained constant and disposal reached zero.
The emitted structure is thin, connected bands with a strong diagonal bias,
rather than an isotropic web or a copy of the target image. Spatial statistics
drift during long rollouts, but the field retains contrast and coherent bands
in the tested runs. The earlier complementary-color noise candidate is not
distributed.

## Xeno Reef

Trained for 1,600 iterations from scratch with the same spatial-v2 recipe as
Filament Network. Final pooled training loss: 0.04787965. The final checkpoint
passed trainer/GPU and GPU/oracle comparisons within one byte and the same
multi-seed 128²/256² rollouts through 8,192 updates plus 2,048 recovery updates.
Allocation accounting remained constant and reached zero after disposal.

The emitted structure is pale faceted growth with teal edges and a vertical
preference; it does not reproduce the target's rounded coral pores. Intermediate
training candidates sometimes flattened or became noisy and are not distributed.
Two earlier local training-browser interruptions were followed by a completed
standalone diagnostic run and a completed full run; their cause was not
established. This does not alter the independent final-checkpoint validation.
