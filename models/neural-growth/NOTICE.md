# Neural Growth attribution and provenance

Neural Growth evaluates one published Texture Neural Cellular
Automaton (NCA). It is not a newly trained Latent Field model, a biological
simulation, or a model of human perception. The main application and development
harness share this checkpoint and the same inference engine.

## Published checkpoint

- Local name: **Vesicle Study**; upstream identifier: `mixed4c_439`, index 41.
- Authors: Eyvind Niklasson, Alexander Mordvintsev, Ettore Randazzo, and Michael Levin.
- Publication: [Self-Organising Textures](https://distill.pub/selforg/2021/textures/),
  February 11, 2021, DOI [10.23915/distill.00027.003](https://doi.org/10.23915/distill.00027.003).
- Repository: [distillpub/post--selforg-textures](https://github.com/distillpub/post--selforg-textures).
- Pinned commit: `24ef9c1eaf3bda8360abc331d5d9509bb7b2a1f1`.
- Source: [public/demo/models.json](https://github.com/distillpub/post--selforg-textures/blob/24ef9c1eaf3bda8360abc331d5d9509bb7b2a1f1/public/demo/models.json).
- Source size: 445,928 bytes.
- Source SHA-256: `32fdd6d0ae6434185abf166b86bb4b75dcf3a0ecbf1c1646e3b1b3ae03b41bee`.
- License: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/),
  as supplied in the [upstream repository license](https://github.com/distillpub/post--selforg-textures/blob/24ef9c1eaf3bda8360abc331d5d9509bb7b2a1f1/LICENSE).

The publication identifies this checkpoint as an NCA trained to excite channel
439 in Inception v1 layer `mixed4c`, producing circle-like structures with
internal texture. Inception was a training-time evaluator, not a network this
browser runtime needs to download or execute. The NCA is distinct from the project's
InceptionV3 DeepDream implementation. No original target photographs, DTD images,
Microscope visualizations, sprite atlases, or pretrained Inception weights are
included here.

### Changes to the published material

`tools/prepare-neural-growth.mjs` verifies the complete source bundle's SHA-256,
decodes its PNG parameter atlases without color correction or resampling, and
extracts just model 41 into numeric byte arrays. It preserves the original
weight scales, bias rows, perception ordering, and quantized values. Changes are
limited to extraction, storage layout, metadata, and the local display name;
there is no training, weight interpolation, or requantization.

`checkpoint.json` remains **CC-BY-4.0** material. The project's MIT source license
does not replace that license. Redistributed copies should retain this
attribution, the license link, source information, and notice of modifications.
The original training data provenance has not been independently audited;
upstream licensing is not a warranty about third-party rights.

## Runtime implementation reference

The runtime math follows the Apache-2.0 reference from
[google-research/self-organising-systems](https://github.com/google-research/self-organising-systems),
pinned at `3d5547ca48b60ecac459834e2c05c9ff5df87991`:

- [texture_ca/ca.js](https://github.com/google-research/self-organising-systems/blob/3d5547ca48b60ecac459834e2c05c9ff5df87991/self_organising_systems/texture_ca/ca.js),
  SHA-256 `a353d2413a7a7d4bf6e54052767cb04ca040e4c808919ab9c8522a411d9f38c3`.
- [texture_ca/export_models.py](https://github.com/google-research/self-organising-systems/blob/3d5547ca48b60ecac459834e2c05c9ff5df87991/self_organising_systems/texture_ca/export_models.py),
  SHA-256 `16facc7bf8c661a3a979e5d8de546ce29a517918fa20a2cb6dd3f088bfc28b6d`.
- [Apache License, Version 2.0](../../licenses/neural-growth-Apache-2.0.txt).

Runtime adaptations replace the reference's multi-model atlas lookup and global
instance state with a single-model engine, explicit resource ownership, and
seeded update scheduling. Fixed-filter perception accumulates in integer byte
space and explicitly selects nearest/half-up rounding, instead of relying on
renderer-dependent floating-point accumulation and implicit RGBA8 UNORM
half-ties. This changes the rounding policy, not the published filter kernels
or learned weight bytes and scales. The prototype UI, deterministic validation,
and lifecycle handling are separate project work. Apache-derived runtime
material retains its license notice; the published checkpoint retains CC-BY-4.0.

## Exported browser arithmetic

- Each cell has 12 state channels; the first three are visible RGB.
- Perception has 48 channels in **filter-major** order: all 12 identity values,
  then all 12 Sobel-x, Sobel-y, and Laplacian values. Reads wrap toroidally.
- Identity perception copies the encoded state byte. Sobel and Laplacian
  perception accumulate `sum(integerCoefficient * (stateByte - 127))`;
  their unchanged kernel coefficients have a denominator of eight. The result
  is encoded as `clamp(floor(sum / 8 + 127 + 0.5), 0, 255)` before being
  written as `encodedByte / 255`. The CPU oracle uses the same nearest/half-up
  policy, avoiding implicit UNORM decisions at half-byte boundaries.
- Dense layers are `[49, 96]` and `[97, 12]`, including the final bias row.
- A weight byte decodes as `(byte - 127) * layerScale / 255`.
- State, perception, and output deltas use the RGBA8 decode
  `4 * (byte / 255 - 127 / 255)`. Hidden activations use `2 * byte / 255`.
- Each stage is quantized and clamped. The hidden unsigned representation
  supplies rectification and a cap of 2; residual state updates are quantized
  again. Display RGB is `state.rgb / 2 + 0.5`.
- Stochastic updates target half the cells per step. This texture model does
  not use Growing NCA's alpha-channel alive gating.

The decode, packing, and dense-layer conventions follow the exported browser
profile, with the explicit perception rounding policy described above.
Reference-browser floating-point perception can differ by one encoded byte at
rounding ties; those differences can propagate through subsequent updates.
No bitwise equivalence to that reference, Python's training-time
fake-quantization implementation, or every GPU is claimed. Validation compares
shared masks and intermediate stages with documented rounding tolerance.

## Reproduction

With Node.js 24 or newer:

```sh
node tools/prepare-neural-growth.mjs
node tools/prepare-neural-growth.mjs --check
```

The first command regenerates only `checkpoint.json`. The second compares it
against the same pinned extraction without changing files. For an offline
check, append `--source /path/to/models.json`; the hash gate remains mandatory.
The tool never stores the complete upstream bundle in this repository.
Network and offline inputs are limited to 1 MiB; downloads have a 30-second
timeout. Offline inputs must be regular files, and file handles close on both
success and failure.
