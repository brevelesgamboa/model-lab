# Autonomous Inception feature checkpoints

`feature-mixed4a-489.json` and `feature-mixed4c-439.json` were supplied in
`transfer_bundle.zip`. Its integration guide identifies these as newly trained
Mode B Texture NCA checkpoints using frozen, pre-ReLU Inception v1 objectives
for mixed4a:489 and mixed4c:439, respectively, and specifies CC-BY-4.0 terms.

The integration assigns unique catalog IDs, descriptive names, source metadata,
and explicit startup settings. Layer shapes, scales, and quantized weights are
unchanged from the supplied files. The matching growth and damage-repair GIFs
are stored in `models/neural-growth/previews/`.

References cited by the supplied guide:

- Olah, Mordvintsev & Schubert, *Feature Visualization* (2017):
  <https://distill.pub/2017/feature-visualization/>
- Niklasson, Mordvintsev, Randazzo & Levin, *Self-Organising Textures* (2021):
  <https://distill.pub/selforg/2021/textures/>

The adapted runtime retains its Apache-2.0 notice. See
`models/neural-growth/NOTICE.md` and `licenses/neural-growth-Apache-2.0.txt`.
