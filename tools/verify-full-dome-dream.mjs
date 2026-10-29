// npm run dev; node tools/verify-full-dome-dream.mjs [photo] [url] [output]
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const photo = path.resolve(
  process.argv[2] || "models/neural-growth/previews/xeno-reef.png",
);
const url = process.argv[3] || "http://127.0.0.1:8081";
const output = path.resolve(
  process.argv[4] || "test-results/full-dome-dream-hardware",
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  args: [
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=vulkan",
    "--enable-features=Vulkan",
    "--enable-gpu",
    "--enable-unsafe-webgpu",
  ],
});
try {
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(url);
  await page.evaluate(async () => {
    const { CorticalDreamDomeModel } =
      await import("/assets/js/models/cortical-dream-dome.js");
    const render = CorticalDreamDomeModel.prototype.render;
    window.domeDraws = 0;
    CorticalDreamDomeModel.prototype.render = async function (...args) {
      window.dome = this;
      const result = await render.apply(this, args);
      window.domeDraws++;
      return result;
    };
  });
  await page.locator("#model-select").selectOption("cortical-dream-dome");
  await page.waitForFunction(() => Boolean(window.dome?.graphics));
  await page.locator("#dome-image").setInputFiles(photo);
  await expect
    .poll(
      () =>
        page.evaluate(() => [window.dome.depthState, window.dome.featureState]),
      {
        timeout: 180000,
      },
    )
    .toEqual(["ready", "ready"]);
  const hardware = await page.evaluate(async () => {
    const gl = window.dome.gl,
      ext = gl.getExtension("WEBGL_debug_renderer_info");
    const adapter = await navigator.gpu?.requestAdapter();
    return {
      renderer: gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL || gl.RENDERER),
      webgpu: adapter
        ? {
            vendor: adapter.info.vendor,
            isFallbackAdapter: adapter.info.isFallbackAdapter,
          }
        : null,
    };
  });
  await page.evaluate(() => {
    window.domeProgress = [];
    const update = window.dome.onStateChange;
    window.dome.onStateChange = () => {
      update();
      if (window.dome.bakeState === "baking")
        window.domeProgress.push(window.dome.bakeProgress);
    };
  });
  const started = Date.now();
  await page.locator("#dome-generate").click();
  await expect
    .poll(() => page.evaluate(() => window.dome.bakeState), { timeout: 240000 })
    .toBe("ready");
  const totalBakeMs = Date.now() - started;
  const verification = await page.evaluate(async () => {
    const { photoProtection } =
      await import("/assets/js/models/equirectangular-canvas.js");
    const w = window.dome.panorama.width,
      h = window.dome.panorama.height;
    const rgba = window.dome.panorama
      .getContext("2d")
      .getImageData(0, 0, w, h).data;
    const seed = window.dome.seed360
      .getContext("2d")
      .getImageData(0, 0, w, h).data;
    let protectedError = 0,
      protectedPixels = 0,
      peripheralChange = 0,
      peripheralSamples = 0,
      emptyPeripheralPixels = 0,
      wrapSquare = 0,
      nearSquare = 0,
      nearCount = 0,
      mirrorDifference = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4,
          p = photoProtection(x, y, window.dome.photoRect);
        if (p === 1) protectedPixels++;
        if (p === 0 && rgba[i] + rgba[i + 1] + rgba[i + 2] === 0)
          emptyPeripheralPixels++;
        for (let c = 0; c < 3; c++) {
          if (p === 1)
            protectedError = Math.max(
              protectedError,
              Math.abs(rgba[i + c] - seed[i + c]),
            );
          if (p === 0) {
            peripheralChange += Math.abs(rgba[i + c] - seed[i + c]);
            peripheralSamples++;
          }
          if (x === 0)
            wrapSquare += (rgba[i + c] - rgba[(y * w + w - 1) * 4 + c]) ** 2;
          if (x > 0 && x < 24) {
            nearSquare += (rgba[i + c] - rgba[i - 4 + c]) ** 2;
            nearCount++;
          }
          if (x < w / 4)
            mirrorDifference += Math.abs(
              rgba[i + c] - rgba[(y * w + w - 1 - x) * 4 + c],
            );
        }
      }
    const { inspectModelCache } =
      await import("/assets/js/core/local-model-cache.js");
    return {
      size: [w, h],
      protectedError,
      protectedPixels,
      emptyPeripheralPixels,
      meanPeripheralChange: peripheralChange / peripheralSamples,
      wrapRms: Math.sqrt(wrapSquare / (h * 3)),
      nearWrapRms: Math.sqrt(nearSquare / nearCount),
      mirroredRearDifference: mirrorDifference / (h * (w / 4) * 3),
      progress: window.domeProgress,
      bake: window.dome.bakeMetrics,
      depthRuns: window.dome.estimator.runs,
      featureRuns: window.dome.featureEstimator.runs,
      dreamRuns: window.dome.baker.runs,
      workerActive: !!window.dome.baker.pending,
      cache: await inspectModelCache(),
      glError: window.dome.gl.getError(),
    };
  });
  const panorama = await page.evaluate(async () => {
    const blob = await window.dome.panorama.convertToBlob({
      type: "image/png",
    });
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(",")[1]);
      r.readAsDataURL(blob);
    });
  });
  await writeFile(
    path.join(output, "panorama.png"),
    Buffer.from(panorama, "base64"),
  );
  for (const [name, yaw, pitch] of [
    ["front", 0, 0],
    ["right", Math.PI / 2, 0],
    ["rear", Math.PI, 0],
    ["left", -Math.PI / 2, 0],
    ["ceiling", 0, 1.4],
    ["floor", 0, -1.4],
  ]) {
    await page.evaluate(
      ({ yaw, pitch }) => {
        window.dome.camera.yaw = yaw;
        window.dome.camera.pitch = pitch;
        window.dome.onStateChange();
      },
      { yaw, pitch },
    );
    await page.waitForTimeout(100);
    await page
      .locator("#output-canvas")
      .screenshot({ path: path.join(output, `${name}.png`) });
  }
  await page.locator("#dome-reset-view").click();
  await page.locator("#toggle-animation").click();
  async function measure(label, look = false) {
    const row = await page.evaluate(
      async ({ label, look }) => {
        const start = performance.now(),
          first = window.domeDraws,
          intervals = [],
          longTasks = [];
        let last = start;
        const observer = new PerformanceObserver((list) =>
          longTasks.push(...list.getEntries().map((e) => e.duration)),
        );
        observer.observe({ entryTypes: ["longtask"] });
        await new Promise((resolve) => {
          function tick() {
            const now = performance.now();
            intervals.push(now - last);
            last = now;
            if (look) window.dome.camera.look(-2, Math.sin(now * 0.002) * 0.1);
            if (now - start < 8000) requestAnimationFrame(tick);
            else resolve();
          }
          requestAnimationFrame(tick);
        });
        observer.disconnect();
        return {
          label,
          elapsedMs: performance.now() - start,
          intervals,
          longTasks,
          draws: window.domeDraws - first,
          canvas: [window.dome.canvas.width, window.dome.canvas.height],
          glError: window.dome.gl.getError(),
          dreamRuns: window.dome.baker.runs,
          workerActive: !!window.dome.baker.pending,
        };
      },
      { label, look },
    );
    const sorted = [...row.intervals].sort((a, b) => a - b);
    return {
      ...row,
      fps: (row.intervals.length * 1000) / row.elapsedMs,
      drawFps: (row.draws * 1000) / row.elapsedMs,
      p99Ms: sorted[Math.floor(sorted.length * 0.99)],
      maxMs: Math.max(...row.intervals),
    };
  }
  const conditions = [
    await measure("Cached 360 field"),
    await measure("360 mouselook", true),
  ];
  await page.locator("#toggle-fullscreen").click();
  await page.waitForFunction(
    () => document.fullscreenElement && window.dome.canvas.width > 768,
  );
  conditions.push(await measure("Fullscreen 360 mouselook", true));
  await page.screenshot({ path: path.join(output, "fullscreen.png") });
  // Block only model-network URLs; app/worker assets still come from the local
  // server. This validates the model cache, not a service-worker offline app.
  let blockedRequests = 0;
  for (const pattern of [
    "**/models/inception/**",
    "https://huggingface.co/**",
    "https://*.hf.co/**",
  ])
    await page.route(pattern, (r) => {
      blockedRequests++;
      return r.abort();
    });
  const offline = await page.evaluate(async () => {
    const { DomeDreamBaker } =
      await import("/assets/js/models/inception-dream-bake.js");
    const { cachedModelFetch, DEPTH_MODEL_URLS } =
      await import("/assets/js/core/local-model-cache.js");
    const baker = new DomeDreamBaker();
    const result = await baker.bake(window.dome.seed360, "mixed_5b", 120, 1);
    const sizes = [];
    for (const url of DEPTH_MODEL_URLS) {
      const r = await cachedModelFetch(url);
      sizes.push((await r.arrayBuffer()).byteLength);
    }
    return {
      iterations: result.iterations,
      retainedTensors: result.retainedTensors,
      depthFileBytes: sizes,
    };
  });
  const report = {
    hardware,
    photoSource: photo.endsWith("verification-photo.jpg")
      ? "https://github.com/DepthAnything/Depth-Anything-V2/blob/main/assets/examples/demo01.jpg"
      : null,
    totalBakeMs,
    verification,
    conditions,
    offline,
    blockedRequests,
    errors,
    notes: [
      "Native GPU benchmark uses Vulkan/unsafe WebGPU Chromium flags; default browser backends can differ.",
      "60 Hz display cadence; higher refresh rates are not verified.",
      "The surrounding field contains abstract neuron features, rather than reconstructed streets/buildings.",
      "Photo center is anchored; wraps use circular filtering and jitter; pole colors converge.",
      "Model cache was tested with model-network requests blocked. App assets still require the local server.",
      "All timing conditions run after the one-shot bake; inference is not part of the render loop.",
    ],
  };
  await writeFile(
    path.join(output, "timing.json"),
    JSON.stringify(report, null, 2),
  );
  const rows = conditions
    .map(
      (r) =>
        `<tr><td>${r.label}</td><td>${r.canvas.join("×")}</td><td>${r.fps.toFixed(1)}</td><td>${r.p99Ms.toFixed(1)}</td><td>${r.maxMs.toFixed(1)}</td></tr>`,
    )
    .join("");
  await writeFile(
    path.join(output, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Full-Dome Inception Dream Field</title><style>body{background:#101218;color:#eee;font:16px system-ui;margin:24px}img{max-width:100%}.view{width:32%}td,th{border:1px solid #555;padding:8px}a{color:#9cf}</style><h1>Full-Dome Inception Dream Field</h1><p>${hardware.renderer}</p><p>15-step bake: ${(verification.bake.bakeMs / 1000).toFixed(2)} s synthesis; ${(totalBakeMs / 1000).toFixed(2)} s total. Protected photo error: ${verification.protectedError}/255. Wrap RMS: ${verification.wrapRms.toFixed(2)}, nearby pixel RMS: ${verification.nearWrapRms.toFixed(2)}.</p><table><tr><th>Condition</th><th>Resolution</th><th>FPS</th><th>p99 ms</th><th>Max ms</th></tr>${rows}</table><p>Inception cache: ${verification.cache.inception.count}/${verification.cache.inception.total} files. Depth: ${verification.cache.depth.count}/${verification.cache.depth.total} files. Fresh worker and depth reads used cached files with model-network requests blocked (${blockedRequests} requests attempted).</p><ul>${report.notes.map((n) => `<li>${n}</li>`).join("")}</ul><p><a href="timing.json">Full measurements</a>${report.photoSource ? ` · <a href="${report.photoSource}">Verification photo source</a>` : ""}</p><img src="panorama.png" alt="Protected photo at the center of a full 360 Inception texture"><h2>Front, right, rear, left, ceiling, floor</h2>${["front", "right", "rear", "left", "ceiling", "floor"].map((n) => `<img class="view" src="${n}.png" alt="${n} view">`).join("")}<h2>Fullscreen</h2><img src="fullscreen.png" alt="Full screen Dream field">`,
  );
  console.log(
    JSON.stringify(
      {
        ...report,
        conditions: conditions.map(({ intervals: _intervals, ...row }) => row),
      },
      null,
      2,
    ),
  );
  console.log(`Saved verification: ${output}`);
  assert.equal(verification.protectedError, 0);
  assert.ok(verification.protectedPixels > 0);
  assert.equal(verification.emptyPeripheralPixels, 0);
  assert.ok(verification.meanPeripheralChange > 5);
  assert.ok(verification.wrapRms <= verification.nearWrapRms * 1.5 + 1);
  assert.ok(verification.mirroredRearDifference > 5);
  assert.equal(verification.bake.iterations, 15);
  assert.equal(verification.bake.retainedTensors, 0);
  assert.equal(verification.workerActive, false);
  assert.equal(verification.glError, 0);
  assert.equal(verification.cache.inception.ready, true);
  assert.equal(verification.cache.depth.ready, true);
  assert.equal(verification.depthRuns, 1);
  assert.equal(verification.dreamRuns, 1);
  assert.equal(blockedRequests, 0);
  assert.equal(offline.retainedTensors, 0);
  assert.ok(offline.depthFileBytes.every((n) => n > 1000));
  assert.deepEqual(errors, []);
  for (const r of conditions) {
    assert.ok(r.fps >= 55);
    assert.ok(r.drawFps >= 55);
    assert.equal(r.glError, 0);
    assert.equal(r.workerActive, false);
    assert.equal(r.dreamRuns, 1);
  }
} finally {
  await browser.close();
}
