# gl-bench

A browser playground for generative graphics and neural visualization, built with vanilla JavaScript, Canvas/WebGL2, ONNX Runtime Web, and TensorFlow.js. Inference runs locally in your browser.

---

## What is Inside

- **Fractals & Chromatic Flow:** Explore animated fractals and shader fields with interactive controls.
- **Neural Growth:** Grow and brush living NCA textures with trained checkpoints, geometry transforms, and temporal effects.
- **Inception Dream:** Transform uploaded images through InceptionV3 feature ascent.
- **Cortical Dream Dome:** Explore a 360° panoramic photo dome with live Neural Growth NCA relief, bio-sheen, autonomous drift, audio-reactive ripples, and optional MI-GAN outpainting.
- **3D Cortical Topography:** Orbit a photo-derived surface with depth and neural relief, animated cortical waves, and pan/zoom controls.
- **Neuron Explorer:** Browse InceptionV3 channels, generate and cache feature previews, and bookmark favorites.
- **DigiFace Generator:** Explore a local ONNX face decoder through latent-coordinate and color controls.
- **Workbench:** Shared controls, Saved Runs, browser training, model-specific PNG/GIF export, and audio/LFO modulation.

---

## Getting Started

### Requirements

- Modern desktop browser with **WebGL2** support
- **Node.js 24+**

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

---

## How It Works and Performance Tips

- **Local data:** Uploaded images are processed in the browser; saved runs and preview caches use browser storage.
- **GPU and resolution:** WebGL2 is required. Lower the simulation grid or preview resolution if NCA growth or Inception feature ascent becomes slow.
- **Neuron previews:** Generate previews on demand or in a background batch that yields to standalone Inception ascent; enable local caching to reuse them after reload.
- **Neural Growth diagnostics:** Press **D** outside an input, or open `/?growthDebug=1`, to show the collapsible Vitality diagnostics panel. It uses cached telemetry and separates recovery blockers from field state. **Force Probe** requests one fenced asynchronous sample, including while paused. **Test Spore** uses the production dose and protection masks, requires a running clock and fresh probe, and bypasses recovery opt-in/baseline learning only. **Raw State View** shows all twelve encoded channels; normal PNG snapshots and saved settings exclude this debug view. Upstream shader NaN/Inf detection remains unavailable.

---

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

---

## Credits and Attribution

This is a personal open-source project building on research and open tooling across generative art and machine learning:

- **Neural Cellular Automata:** Inspired by the work of Alexander Mordvintsev, Eyvind Niklasson, Ettore Randazzo, and the Distill team (_[Growing Neural Cellular Automata](https://distill.pub/2020/growing-ca/)_).
- **DigiFace Decoder:** Trained from scratch using synthetic face data from Microsoft's [DigiFace-1M](https://github.com/microsoft/DigiFace1M) dataset (used for non-commercial research/experimentation).
- **DeepDream / Inception:** The browser uses InceptionV3. Some imported autonomous NCA models were trained against Inception v1 (GoogLeNet) feature objectives.
- **Libraries:** [TensorFlow.js](https://www.tensorflow.org/js) and [ONNX Runtime Web](https://onnxruntime.ai/).

### License

- Application source code is licensed under **[MIT](LICENSE)**.
- Checkpoints and external datasets retain their respective research/source licenses. See `THIRD_PARTY_NOTICES.md` for details.
