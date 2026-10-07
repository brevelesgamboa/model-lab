# Release checklist

## Automated gates

- npm ci from a clean checkout, with no generated runtime or dist folders.
- npm run build: syntax/import/DOM/runtime checks, lint, neural asset hashes.
- npm test: parameter schema, playback/render serialization, quality, static server, staged model storage.
- npm run test:browser: retained views, controls, responsive widths, local persistence/export, PCA training, ONNX, stored neural inference, Inception gradients/checkpoint.
- No retired route or private local runtime directory in dist.
- No generated files tracked; dependency audit reviewed.
- Application LICENSE, decoder research terms, and model notices included and served in the static build.

## Manual acceptance on real devices

- Chromium desktop WebGL; available WebGPU adapter; Firefox/Safari fallback.
- 360px mobile and desktop layouts, keyboard navigation, visible focus, fullscreen exit.
- Real Inception source upload, Quality/Reduced Compute switching, completed multi-octave result.
- Switch views/hide tab during ascent, then resume without losing the visible image.
- Parameter edits and reset while processing; source replacement does not commit stale output.
- Audio permission accepted, denied, and stopped; no tracks left active.
- GIF output, 2K/4K supported/unsupported behavior, storage-quota errors.
- Five-minute neural training, stop/failure, and previous model survival during replacement.

Automated software-GPU checks cannot establish interactive FPS, physical GPU choice, visual quality, or every browser's fullscreen/audio behavior.

## Publication blockers

- [x] Application source licensed under MIT, separately from model weights.
- [x] DigiFace author confirms from-scratch training; provenance, attribution, and decoder research terms recorded.
- [ ] Inception checkpoint source/conversion and redistribution rights recorded.
- [ ] DigiFace release scope and trained-Results condition reviewed against the dataset agreement.
- [ ] Real-device manual acceptance completed.
- [ ] Maintainer reviews changes, commits, and chooses a release tag.

Do not publish release assets until the legal/provenance gates are resolved. Generated builds are local validation artifacts, not proof of redistribution clearance.

## Local validation — 2026-10-05

- Node.js 24.21.0, Chromium 153 with software WebGL/WASM fallback.
- Empty dependency/runtime/build snapshot: npm ci, build, and 15 unit tests passed.
- 11 browser tests passed, including real ONNX and Inception gradients, complete reduced-compute ascent, upload, pause/resume, pipeline canvas preservation, PCA persistence, and PNG capture.
- ONNX diagnostic page, formatter, lint, model checksums, and whitespace checks passed.
- npm dependency audit reported zero known vulnerabilities at validation time.
- Desktop/mobile screenshots inspected; automated layout checks covered 360/900/1440px.
- Generated runtimes reduced from approximately 109 MiB to 38 MiB; generated files removed from Git tracking, with local builds retained. Git history was not rewritten.
- Licensing/provenance follow-up: build and lint, 17 unit tests, and all 11 browser tests passed. Built license, notice, metadata, and decoder files matched source exactly; the decoder's SHA-256 was unchanged. The browser ONNX regression verified that the build serves the application MIT license and separate decoder research terms.

This validation does not clear the unchecked publication blockers or the real-device manual checks above.
