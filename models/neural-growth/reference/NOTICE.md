# Neural Growth reference checkpoints attribution and provenance

This directory contains the 66 published Texture Neural Cellular Automata (NCA) checkpoints extracted from the Distill *Self-Organising Textures* research collection.

## Upstream Provenance

- Publication: [Self-Organising Textures](https://distill.pub/selforg/2021/textures/), February 11, 2021, DOI [10.23915/distill.00027.003](https://doi.org/10.23915/distill.00027.003).
- Authors: Eyvind Niklasson, Alexander Mordvintsev, Ettore Randazzo, and Michael Levin.
- Upstream Repository: [distillpub/post--selforg-textures](https://github.com/distillpub/post--selforg-textures).
- Pinned Commit: `24ef9c1eaf3bda8360abc331d5d9509bb7b2a1f1`.
- Source File: `public/demo/models.json` (SHA-256 `32fdd6d0ae6434185abf166b86bb4b75dcf3a0ecbf1c1646e3b1b3ae03b41bee`).
- License: [Creative Commons Attribution 4.0 International (CC-BY-4.0)](https://creativecommons.org/licenses/by/4.0/).

## Model Categories

1. **Texture References (Models 0–38)**:
   39 models trained on photographic texture patterns using pretrained VGG feature Gram matrix style loss. (VGG is used solely at training time; it is never loaded by this browser runtime).
2. **Inception Feature References (Models 39–65)**:
   27 models trained to excite individual convolutional channel activations within Inception-v1 (such as `mixed4c_439`, `mixed4d_473`, etc.).

## Modifications from Source

Checkpoints are extracted directly from the published PNG parameter atlas using `tools/prepare-neural-growth.mjs` and `tools/extract-all-reference-models.mjs`. Weights, scales, bias terms, and perception channel orderings are preserved bit-for-bit with 100% numerical fidelity and zero requantization. The files are converted from atlas PNG layout to standardized JSON for lazy on-demand client loading.

