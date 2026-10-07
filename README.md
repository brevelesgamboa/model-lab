# Latent Field

A local-first browser workspace for generative graphics and feature visualization. Vanilla JavaScript modules, Canvas/WebGL, ONNX Runtime Web, and TensorFlow.js; no application framework or bundler.

## What is included

- Lab: Chromatic Flow, Folded Fractal, Fractal Explorer, DigiFace VAE, Inception Dream, and Neural Growth.
- Saved Runs: parameter snapshots and local high-resolution fractal captures.
- Experiments: optional Quick PCA training, experimental convolutional autoencoder training, and Wikimedia Commons image search.
- About: model explanations, rendering limits, and the fractal process breakdown.

The older MobileNet Neural Dream route, dog-specific presets, brush/fusion controls, floating preset strip, and one-time introduction are retired. Existing Studio/Datasets/Method links map to Experiments/About.

## Run locally

Use Node.js 24 or newer and a current desktop browser.

```sh
npm ci
npm run dev
```

Open the address printed by the server (default: http://127.0.0.1:8080). Change `PORT` or `HOST` if needed. WebGL2 accelerates the graphics routes; ONNX can fall back to WASM. Inception requires a gradient-verified WebGL or WebGPU backend. Neural training requires passing the WebGL benchmark. Browser API availability is not a promise of performance.

The checked-in models comprise a DigiFace ONNX decoder, the Inception graph plus 23 weight shards, and a 75 KiB Texture NCA checkpoint, approximately 100 MB total. Runtime preparation uses the pinned npm dependencies. Generated runtimes and `dist/` are not source files and are not tracked.

The DigiFace decoder is already trained and bundled. Users do not need to train it or download Microsoft's image dataset. Training in Experiments is an independent, optional workflow for creating a different local model.

## Build and verify

```sh
npm run build
npm test
npx playwright install chromium
npm run test:browser
npm start
```

The build validates imports, DOM bindings, JavaScript syntax, runtime presence, and model checksums before copying an explicit set of assets into `dist/`. Browser tests exercise the UI, responsive layouts, storage, PNG capture, PCA training, real ONNX inference, stored neural inference, real Inception graph gradients, and Neural Growth state/capture lifecycles.

`npm run check` includes linting. `npm run format` applies the shared formatter. `runtime-check.html` is an optional ONNX diagnostic page. Starting without a built `dist/index.html` fails explicitly; use `npm run dev` for source development.

## Inception Dream

Choose an image, load the model, then run feature ascent. The objective is the sum of mean activations from Mixed_6a and Mixed_6c. Gradients are normalized by their standard deviation; each update clips RGB values to [0, 1]. Octaves rescale the image by 1.3×.

Quality and Reduced Compute both use this same objective. Reduced Compute caps the working resolution, octave count, and steps. This is iterative optimization, not a 24 FPS morph stream. Pipeline changes preserve the visible output while recomputing. Navigation and tab visibility pause work; a single retained tensor allows ascent to resume. Source replacement or reset invalidates that checkpoint.

## Neural Growth

Neural Growth uses small learned local rules to evolve 12 state channels per
cell into textures. PATTERN includes the original Organic Structures pack and
the explicitly labeled published Vesicle Study reference. Original patterns are
trained from scratch against AI-generated imagined biological/alien textures;
they are not biological simulations or models of human perception. Inception v1
was used for the published reference's training objective, not browser inference.
No end-user training, separate model download, or additional runtime dependency
is required. See [the original pack notice](models/neural-growth/organic-structures/NOTICE.md)
for the training objective, provenance, and device-specific validation.

Use CLOCK to play/pause, SINGLE STEP to advance once while paused, RESTART to
reset, and DISTURB CENTER or click/drag on the field to clear a local region.
Pattern, seed and 128/256 grid changes deliberately restart; speed, palette, viewport
resizing, navigation, and model switching preserve the current grid. Growth speed
is a requested rate, capped at two updates per frame without accumulated catch-up.
The default 128² grid is lighter; 256² adds simulation detail, not just display pixels.
Patterns load on demand and cache their weights, not their simulation grids.
Failed replacements retain the previous field and attribution; Restart retries
explicitly. Superseded downloads cannot paint or reset the current field.

WebGL2 is required. PNG exports a display-sized snapshot without advancing state.
GIF, high-resolution resimulation, and restorable Saved Runs are unavailable;
parameter records do not contain the hidden cell state. Session state is not
retained after reload. Source attribution and separate CC-BY-4.0/Apache-2.0 terms:
[published Neural Growth notice](models/neural-growth/NOTICE.md). Original pack
weights have their own explicit MIT grant in the original pack notice.

The [development harness](prototypes/neural-growth/README.md) shares the production
engine and checkpoint; it remains outside the static build. Validation commands
and device-specific evidence are in [VALIDATION.md](prototypes/neural-growth/VALIDATION.md).

## Performance and local data

Auto preview starts conservatively at 384–768 pixels. Higher resolutions are explicit choices; high-resolution fractal exports are independent of preview size. Rendering is serialized, off-Lab/hidden-tab clocks stop, and training/model loading takes an exclusive compute lease.

Saved runs and trained models use browser storage. Local images are processed locally, not uploaded. Clearing site data removes saved state. Storage quotas vary; unavailable persistence is identified as session-only. Wikimedia search/downloads and optional Google Fonts are network requests. Audio requires an explicit browser sharing permission and is never uploaded.

Inception image sources are not part of saved parameter runs; export PNG to preserve their output. GIF capture is unavailable for Inception's internal optimization engine.

## Organization

```text
assets/js/app/          controls, playback, navigation, render, and dream controllers
assets/js/capture/      PNG/GIF export and high-resolution gallery
assets/js/models/       model adapters and their control definitions
assets/js/core/         model contract, runtime loading, storage, metrics, modulation
assets/js/training/     benchmark, dataset processing, and neural training
assets/js/studio/       optional Experiments workflow
assets/js/workers/      PCA training worker
assets/css/             shared design tokens and component styles
models/                 checked-in neural assets and model notices
licenses/               runtime licenses and separate decoder research terms
tools/                  runtime preparation, integrity checks, and static build
tests/                  unit and Chromium browser regressions
```

See [ADDING_MODELS.md](ADDING_MODELS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [DIGIFACE_INTEGRATION.md](DIGIFACE_INTEGRATION.md).

## Licensing

The application's own source code and documentation are open source under [MIT](LICENSE). Third-party components and model weights are excluded from that grant and retain their separate terms.

The project author trained the DigiFace-derived decoder from scratch. Its weights are provided under [non-commercial research terms](licenses/digiface-decoder-research.txt), with attribution and provenance in [DIGIFACE_INTEGRATION.md](DIGIFACE_INTEGRATION.md). They are not MIT-licensed. The Inception checkpoint's origin and redistribution rights remain unverified. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Release status

This is a release candidate, not a fully cleared public release. Source licensing and the DigiFace decoder's author-reported origin are now recorded. Inception provenance, the DigiFace release's compliance with the dataset agreement, and real-device acceptance still need review. Local builds retain both models for validation; a successful build does not establish redistribution rights. See [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).
