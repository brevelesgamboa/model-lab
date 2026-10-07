# Original pattern training

Development-only training for the `latent-field-texture-nca-v1` profile. This
directory is not copied into the static application build. End users load a
checkpoint; they do not train a model or download a feature extractor.

## Membrane Field target

`targets/membrane-field.png` is an AI-generated original texture created with the
built-in image-generation tool on 2026-10-06. It depicts imagined membranes, not
a biological specimen or medical image. No published NCA target image was used.

Final Membrane Field generation prompt:

```text
Use case: stylized-concept
Asset type: square texture target for an original neural cellular automaton pattern pack
Primary request: Membrane Field — an original abstract biological/alien texture of irregular interlocking translucent cells, cavities and layered membrane boundaries.
Style/medium: detailed tactile digital texture, biological structure imagined rather than a real medical specimen.
Composition/framing: edge-to-edge top-down surface, fairly uniform scale across the image, many medium-sized interconnected cavities; no central subject or perspective.
Lighting/mood: luminous layered membranes against darker cavities, crisp readable boundaries with restrained internal texture.
Constraints: square image; varied organic shapes rather than a regular honeycomb; broad connected forms that remain readable when reduced to 128 pixels; no words, labels, logo, watermark, frame, human or animal subject.
```

## Additional targets

`targets/filament-network.png`, generated with the built-in tool:

```text
Use case: stylized-concept
Asset type: square texture target for an original neural cellular automaton pattern pack
Primary request: Filament Network — an imagined biological/alien surface of thin branching strands that reconnect into irregular loops and networks.
Style/medium: tactile digital texture with restrained luminous filament edges and dark space between strands.
Composition/framing: edge-to-edge top-down, uniform scale, many medium-sized branching networks; open dark interstices and occasional small junctions. Organic, irregular, not a regular grid.
Constraints: broad filament paths clearly readable at 128 pixels; no dominant central object, perspective, text, logo, watermark, frame, human or animal subject. Different structural character from broad cellular membranes. Imagined biology, not a medical specimen.
```

`targets/xeno-reef.png`, generated with the built-in tool:

```text
Use case: stylized-concept
Asset type: square texture target for an original neural cellular automaton pattern pack
Primary request: Xeno Reef — an original imagined alien biological surface of clustered porous nodules and coral-like growth, repeating irregular rounded pores in dense connected tissue.
Style/medium: detailed tactile digital surface texture, soft mineral-biological material, subtle luminous pore interiors.
Composition/framing: edge-to-edge top-down, uniform scale, many medium-sized rounded cavities and clustered nodules; no central subject, landscape or perspective.
Constraints: forms remain clearly readable when reduced to 128 pixels; more porous and clustered than a membrane or filament network; no words, labels, logos, watermark, border, recognizable human or animal, real scientific specimen or medical claim.
```

## Recipe

The trainer initializes both dense layers from scratch, rather than fine-tuning
the published Vesicle Study checkpoint. Twelve state channels, four periodic
perception filters, 96 hidden units, quantized state/weights/hidden activations,
and translated half-grid update masks match the production architecture.
Straight-through rounding gradients permit quantization-aware training. Weight
scales are fixed at 4 and 2; hidden activations are clamped to [0, 2].

The `multiscale-fixed-feature-gram-v1` objective matches Gram statistics of a
seeded, frozen random 3×3 convolution bank at four image scales, plus RGB means
and second moments. It is **not** the published VGG objective, and uses no
pretrained image network or external training dataset. A 32-state pool includes
fresh blank states and circular damage; Adam trains two samples for a random
24–40 updates per iteration on 32² grids. Exported models must independently
pass larger-grid growth and recovery checks before release.

The optional `spatial` recipe adds RGB cross-channel Gram statistics and
horizontal/vertical neighbor differences at each scale. It is identified as
`multiscale-fixed-feature-spatial-v2`; its losses are not directly comparable to
v1. This stronger objective addresses candidates that match marginal colors but
settle into complementary-color pixel noise. Numerical parity and manual visual
inspection remain required; a falling loss is not a release criterion.

With dependencies and local TensorFlow.js assets prepared:

```sh
node tools/train-neural-growth.mjs 1200 /tmp/latent-field-membrane-training
node tools/train-neural-growth.mjs 1200 /tmp/latent-field-filament-training filament-network
node tools/train-neural-growth.mjs 1200 /tmp/latent-field-reef-training xeno-reef
node tools/train-neural-growth.mjs 1600 /tmp/latent-field-filament-spatial filament-network spatial
node tools/validate-original-pattern.mjs /path/to/checkpoint.json /tmp/pattern-validation
node tools/validate-original-pattern.mjs /path/to/spatial-checkpoint.json /tmp/spatial-validation spatial
```

The runner binds only to localhost, serves an exact file allowlist, and saves
intermediate checkpoints, training records, and production-renderer previews.
It requests the local OpenGL GPU through Chromium. Inspect the reported renderer
before treating speed measurements as hardware results. Training remains
experimental until the checkpoint's validation record says otherwise.
