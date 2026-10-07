# Changelog

## 1.1.0 — Unreleased

- Consolidate navigation into Lab, Saved Runs, Experiments, and About.
- Retire the older Neural Dream route and redundant presets/intro/training switches.
- Extract playback, rendering, controls, navigation, dream, and export controllers.
- Pause compute off Lab and on hidden tabs; serialize GPU operations.
- Retain resumable Inception ascent checkpoints and guard stale canvas writes.
- Validate control schemas and migrate/sanitize stored parameters.
- Make local neural weight replacement transactional.
- Prepare smaller pinned browser runtimes instead of tracking generated copies.
- Consolidate styles, improve responsive sizing/readability, hide session logs by default.
- Add linting, unit/browser regressions, CI, model integrity checks, and release documentation.
- License application code under MIT; retain the pretrained DigiFace decoder with separate research terms and author-confirmed from-scratch provenance.
- Include application and decoder terms in static builds and verify their public serving.

Inception provenance, DigiFace dataset-agreement compliance, and real-device acceptance remain release gates.
