# Contributing

Use Node.js 24+. Install with npm ci; do not edit generated assets/vendor or dist files.

Before submitting changes:

```sh
npm run format
npm run build
npm test
npx playwright install chromium
npm run test:browser
```

Keep changes focused: model-specific compute belongs in the adapter; shared UI behavior belongs in the app controllers. Define controls through the model contract. Prefer explicit resource ownership, bounded state, and tested cancellation over backend-specific claims.

Add regressions for bugs, especially asynchronous canvas writes, navigation/visibility pauses, storage failure, and model replacement. Browser tests use software WebGL in Chromium for reproducibility; they do not substitute for real-device performance testing.

Do not add features or dependencies without explaining their purpose and maintenance cost. Do not commit generated runtimes, exports, browser traces, local training data, or model weights without documented provenance and redistribution authority.

The project's own source code and documentation are MIT-licensed; see LICENSE. Contributions to them use those terms. Model weights and third-party components have separate terms; do not apply the application MIT license to them.
