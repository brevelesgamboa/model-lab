# Third-party components and model assets

## Application code

Latent Field's own source code and documentation are MIT-licensed; see LICENSE. This grant excludes third-party components and all model weights. Their applicable terms are documented below.

## Browser runtimes

- TensorFlow.js and its WebGPU backend, version 4.22.0: Apache-2.0. License text: licenses/tensorflow-Apache-2.0.txt. Source: https://github.com/tensorflow/tfjs/tree/tfjs-v4.22.0
- ONNX Runtime Web, version 1.27.0: MIT. License text: licenses/onnxruntime-MIT.txt. Source: https://github.com/microsoft/onnxruntime/tree/v1.27.0

Generated runtime folders retain these license files. Development dependencies are not shipped in the static build; their upstream package licenses remain in node_modules.

## Neural weights

Runtime licensing is separate from the rights to model weights and datasets.

- DigiFace decoder: SHA-256 d9e4883cd689734843f15e2ee0a16e64f5f98527cdc801d40ba87bf0c2788e7d. The project author confirmed training from scratch on a DigiFace-1M subset, without an external pretrained checkpoint, on 2026-10-05. This is not an official Microsoft model. Weights are supplied under licenses/digiface-decoder-research.txt, not MIT. Keep models/digiface/NOTICE.txt with copies. Dataset agreement: https://github.com/microsoft/DigiFace1M/blob/main/LICENSE. Further provenance and limitations: DIGIFACE_INTEGRATION.md.
- Inception graph: SHA-256 10256b8f8d3afd623a0ce762417a27e106c41f6f8582152fb32f6dcf03123849. Full shard inventory: tools/model-assets.json. The graph identifies InceptionV3/TF-Slim operations; this is not evidence of the checkpoint's original download source or license. Original checkpoint source, conversion history, and redistribution authority are not recorded.

Inception rights remain an unresolved public-release blocker. DigiFace's self-trained origin is recorded, but release compliance with the dataset agreement still requires review. Neither model is represented as unrestricted open-source weights.

## Texture NCA (Neural Growth)

- Published checkpoint: `models/neural-growth/checkpoint.json`, local name
  Vesicle Study, upstream `mixed4c_439`, index 41. Authors: Eyvind Niklasson,
  Alexander Mordvintsev, Ettore Randazzo, and Michael Levin.
  [Self-Organising Textures](https://distill.pub/selforg/2021/textures/).
  CC-BY-4.0 under the pinned Distill repository license; extraction does not
  train or requantize weights. Preserve [NOTICE.md](models/neural-growth/NOTICE.md)
  with redistributed copies. The project's MIT grant does not cover this asset.
- `assets/js/models/neural-growth/runtime.js` is adapted from Google Research's
  Texture NCA browser implementation under Apache-2.0. License text:
  [licenses/neural-growth-Apache-2.0.txt](licenses/neural-growth-Apache-2.0.txt).
  Pinned references, changes, hashes, numerical conventions, and reproduction
  are documented in the same model notice.

This is a published reference model, not an original Latent Field checkpoint.
Upstream terms do not independently establish all original training-data rights.
The separate Inception and DigiFace release review remains outstanding.

## Other external resources

Google Fonts supplies Gajraj One and IBM Plex Mono/Sans via optional network stylesheets; local system fonts provide fallbacks. Wikimedia Commons search returns individually licensed media; attribution/license metadata must be retained and reviewed per asset. User-provided images and browser-trained models remain the user's responsibility.

Runtime licenses do not grant rights to either model's weights or training data.
