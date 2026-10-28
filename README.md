# gl-bench

A local-first browser playground for generative shaders, fractals, and neural visualization. 

Built with vanilla JavaScript modules, Canvas/WebGL2, ONNX Runtime Web, and TensorFlow.js. No heavy frameworks or bundlers required; everything runs locally in your browser.

***

## What is Inside

* **Fractals and Shaders:** Chromatic Flow, Folded Fractal, and Fractal Explorer with high-res export support.
* **Neural Growth:** Interactive Neural Cellular Automata (NCA) that simulate organic textures (Membrane Field, Filament Network, Xeno Reef, and Vesicle Study).
* **Inception Dream:** DeepDream-style feature ascent on custom images using InceptionV3 feature layers.
* **Cortical Dream Dome:** Look around inside a photo shaped by relative depth, a selected Inception channel, and animated cortical waves. The separate 3D Cortical Topography route remains available.
* **Neuron explorer:** Browse InceptionV3 channels, inspect feature previews, bookmark favorites, and choose Dream targets. Generate previews explicitly or start a background batch for a page, layer, or channel range.
* **DigiFace VAE:** Interactive face decoder explorer running through an ONNX decoder.
* **Workbench shell:** Persistent Lab canvas, model controls, brush tools, capture actions, and the existing local audio EQ. Saved Runs, Experiments, and About are empty route placeholders in this frontend pass.
* **Modulation preview:** The nested SVG drawer is a visual draft. Existing working LFO and audio routes remain available under Advanced routing. Browser training and archive controller targets remain hidden in the DOM for the next UI pass.

***

## Getting Started

### Requirements
* Modern desktop browser with **WebGL2** support
* **Node.js 24+**

### Run locally

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:8080` in your browser.

### Build and Test

```sh
# Build static site to dist/
npm run build

# Run unit tests and browser tests (Playwright)
npm test
npx playwright install chromium
npm run test:browser
```

> **Note on models:** The app uses prepared local DigiFace, InceptionV3, and NCA assets. Imported feature-trained NCA checkpoints can use Inception v1 as their training objective; their channel identifiers do not map directly to the browser's InceptionV3 channels.

***

## How It Works and Performance Tips

* **100% Local:** Uploaded images and saved parameter runs never leave your machine. They are processed in memory or saved directly to browser storage.
* **GPU Requirements:** Shaders and NCA simulations require WebGL2. Inception feature ascent runs optimization passes through TensorFlow.js, which benefits heavily from a decent GPU.
* **Resolution:** Preview sizes start conservative (384 to 768px) to keep frame rates smooth. Use the export button when you want high-resolution captures.
* **Neuron previews:** Opening the explorer, browsing, and selecting a channel do not start optimization. Use **Generate neuron preview**, **Preview selected neuron**, or **Start background cache**. A background batch runs sequentially and yields to live guidance. It continues after the explorer closes while this tab remains open; closing the tab or switching away from Neural Growth stops it. Saved images are reused after reload; unfinished batches require another explicit start.
* **Preview storage:** The optional local preview cache keeps up to 4,096 images within a 64 MiB image-data budget, evicting the oldest used entries when full. Favorites, recently viewed neurons, and explorer filters are remembered separately for each checkpoint. Pausing, resuming, cancelling, or clearing a batch never changes the simulation's field or Dream settings.

### Cortical Dream Dome

Choose **Cortical Dream Dome (360)** in **Model Route**, upload a photo, and turn the clock on. Drag or use arrow keys to look around; **Full** fills the screen and **Reset view** returns to the front. The front 140° shows the photo, with a mirrored continuation around the rear.

**Depth Scale** controls relief, **Neural Swell** raises areas that activate the selected channel, and **Wave Gain** controls moving rings, rays, spirals or honeycomb. Each photo runs depth and forward-only Inception mapping once. Changing the feature target refreshes only that map. These are feature responses and analytic waves, rather than DeepDream ascent or a cortical neural-field solver. The **?** help links to the papers.

Maps and camera state remain in the current tab; PNG and GIF export the view. A missing model leaves brightness relief and waves usable, with an explicit retry button. For the hardware benchmark: `node tools/verify-cortical-dream-dome.mjs path/to/photo.jpg` with the development server running on port 8081 (or pass its URL as the second argument).

### Cortical Stack export handoff

The training workspace can deliver a trained stack after static visual review and rollout/recovery validation. Export the existing `latent-field-texture-nca-v1` profile: 12 state channels, four periodic perception filters, 96 hidden units, dense shapes `[49, 96]` and `[97, 12]`, quantized unsigned-byte weights with scales, and explicit startup settings. Match the browser's state/activation quantization and sparse update rules in `assets/js/models/neural-growth/reference.js`. A training-only alive-cell update mask would require a coordinated runtime change.

Supply the checkpoint, growth and damage-recovery previews, source-network/checkpoint identity, tier layer/channel IDs, tier weights and normalization method, seeds/startup configuration, training settings, and source/license metadata. The eventual app destination is `models/neural-growth/features/`, with gallery registration and integrity hashes in `tools/model-assets.json`. Release requires production WebGL2 checks at 128² and 256², several seeds, sustained rollouts, recovery review, and measured performance. Runtime multi-tier InceptionV3 guidance is a separate experiment from deploying the autonomous trained checkpoint.

***

## Project Structure

```text
assets/js/app/       UI controls, rendering loop, and view controllers
assets/js/models/    Adapters and parameter definitions for models
assets/js/core/      Runtime loaders, storage, and shared utilities
assets/js/training/  Browser-side training scripts and benchmarks
models/              Bundled neural net checkpoints and notices
tools/               Build scripts and integrity checks
tests/               Playwright browser tests and unit tests
```

***

## Credits and Attribution

This is a personal open-source project building on research and open tooling across generative art and machine learning:

* **Neural Cellular Automata:** Inspired by the work of Alexander Mordvintsev, Eyvind Niklasson, Ettore Randazzo, and the Distill team (*[Growing Neural Cellular Automata](https://distill.pub/2020/growing-ca/)*).
* **DigiFace Decoder:** Trained from scratch using synthetic face data from Microsoft's [DigiFace-1M](https://github.com/microsoft/DigiFace1M) dataset (used for non-commercial research/experimentation).
* **DeepDream / Inception:** The browser uses InceptionV3. Some imported autonomous NCA models were trained against Inception v1 (GoogLeNet) feature objectives.
* **Libraries:** [TensorFlow.js](https://www.tensorflow.org/js) and [ONNX Runtime Web](https://onnxruntime.ai/).

### License

* Application source code is licensed under **[MIT](LICENSE)**.
* Checkpoints and external datasets retain their respective research/source licenses. See `THIRD_PARTY_NOTICES.md` for details.
