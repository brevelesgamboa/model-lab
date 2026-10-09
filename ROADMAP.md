# Latent Field Roadmap

Development milestones and planned directions for Latent Field.

## Current Milestone: Neural Growth Custom Texture Library

Integrating 22 custom-trained Neural Cellular Automata (NCA) models alongside the reference catalog.

- Clean Model Packaging: Store all custom models in models/neural-growth/custom with clean IDs, readable names, and preserved weight scales.
- Noise Initialization Runtime: Support models that require Gaussian noise seeds (seedState: noise) on canvas reset alongside zero-state models.
- Unified Gallery: Present custom models directly in the Pattern Gallery under the Originals category without unnecessary sub-pack clutter.
- Verification and Integrity: Maintain verified SHA-256 asset checksums and unit test coverage.

## Milestone 2: Visual Style Expansions

- 3D Relief and Depth Illusions: Train models focusing on directional lighting, chiseled stone, and embossed metallic textures.
- Ocular and Biological Pareidolia: Explore high-pareidolia eye colonies and organic cell structures.
- Alien and Xenomorphic Surfaces: Train iridescent chitin and bioluminescent pore patterns.

## Milestone 3: Interaction and Audio Modulation

- Enhanced Brush Tools: Additional disturbance modes and brush shape controls.
- Audio Reactive Controls: Expand modulation routing for rotation, speed, and disturbance from audio analysis.
- Performance Tuning: WebGL2 shader optimizations for higher frame rates on mobile and lower-power hardware.

