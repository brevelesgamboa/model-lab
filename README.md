# Latent Field

A local-first browser playground for generative shaders, fractals, and neural visualization. 

Built with vanilla JavaScript modules, Canvas/WebGL2, ONNX Runtime Web, and TensorFlow.js. No heavy frameworks or bundlers required; everything runs locally in your browser.

***

## What is Inside

* **Fractals and Shaders:** Chromatic Flow, Folded Fractal, and Fractal Explorer with high-res export support.
* **Neural Growth:** Interactive Neural Cellular Automata (NCA) that simulate organic textures (Membrane Field, Filament Network, Xeno Reef, and Vesicle Study).
* **Inception Dream:** DeepDream-style feature ascent on custom images using Inception v1 feature layers.
* **DigiFace VAE:** Interactive latent face explorer running through an ONNX decoder.
* **Toy Experiments:** Quick browser-based PCA, experimental autoencoder training, and a Wikimedia image search tool for sourcing textures.

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

> **Note on models:** The repo includes pre-packaged weights (about 100 MB total: the DigiFace ONNX decoder, Inception v1 shards, and NCA checkpoints). You do not need to download external weights or datasets just to try the demos.

***

## How It Works and Performance Tips

* **100% Local:** Uploaded images and saved parameter runs never leave your machine. They are processed in memory or saved directly to browser storage.
* **GPU Requirements:** Shaders and NCA simulations require WebGL2. Inception feature ascent runs optimization passes through TensorFlow.js, which benefits heavily from a decent GPU.
* **Resolution:** Preview sizes start conservative (384 to 768px) to keep frame rates smooth. Use the export button when you want high-resolution captures.

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
* **DeepDream / Inception:** Based on feature visualization techniques using the Inception v1 (GoogLeNet) architecture.
* **Libraries:** [TensorFlow.js](https://www.tensorflow.org/js) and [ONNX Runtime Web](https://onnxruntime.ai/).

### License

* Application source code is licensed under **[MIT](LICENSE)**.
* Checkpoints and external datasets retain their respective research/source licenses. See `THIRD_PARTY_NOTICES.md` for details.