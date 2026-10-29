// npm run dev; node tools/verify-cortical-dream-dome.mjs [photo] [url] [output]
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const photo = path.resolve(
  process.argv[2] || "models/neural-growth/previews/xeno-reef.png",
);
const url = process.argv[3] || "http://127.0.0.1:8081";
const output = path.resolve(
  process.argv[4] || "test-results/cortical-dream-dome-hardware",
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
  });
  const errors = [],
    downloads = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().includes("huggingface.co")) downloads.push(r.url());
  });
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
  await page.waitForFunction(() => window.dome?.graphics);
  await page.locator("#toggle-animation").click();
  const hardware = await page.evaluate(async () => {
    const gl = window.dome.gl,
      ext = gl.getExtension("WEBGL_debug_renderer_info");
    const adapter = await navigator.gpu?.requestAdapter({
      powerPreference: "high-performance",
    });
    return {
      renderer: gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL || gl.RENDERER),
      webgpu: adapter
        ? {
            vendor: adapter.info.vendor,
            architecture: adapter.info.architecture,
            isFallbackAdapter: adapter.info.isFallbackAdapter,
          }
        : null,
      canvas: [gl.canvas.width, gl.canvas.height],
      mesh: [256, 256],
    };
  });
  async function measure(label, look = false) {
    const result = await page.evaluate(
      async ({ label, look }) => {
        const start = performance.now(),
          firstDraw = window.domeDraws;
        let last = start;
        const intervals = [],
          longTasks = [];
        const observer = new PerformanceObserver((list) =>
          longTasks.push(
            ...list.getEntries().map((e) => ({
              start: e.startTime - start,
              duration: e.duration,
            })),
          ),
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
          draws: window.domeDraws - firstDraw,
          runs: window.dome.estimator.runs,
          workerActive: !!window.dome.estimator.pending,
          featureRuns: window.dome.featureEstimator.runs,
          featureWorkerActive: !!window.dome.featureEstimator.pending,
          featureTarget: window.dome.featureMap.layer || null,
          featureShape: [
            window.dome.featureMap.height,
            window.dome.featureMap.width,
          ],
          featureInferenceMs: window.dome.featureMap.inferenceMs || null,
          canvas: [window.dome.canvas.width, window.dome.canvas.height],
          glError: window.dome.gl.getError(),
        };
      },
      { label, look },
    );
    const sorted = [...result.intervals].sort((a, b) => a - b),
      quantile = (p) =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    return {
      ...result,
      fps: (result.intervals.length * 1000) / result.elapsedMs,
      drawFps: (result.draws * 1000) / result.elapsedMs,
      p95Ms: quantile(0.95),
      p99Ms: quantile(0.99),
      maxMs: Math.max(...result.intervals),
    };
  }
  const demo = await measure("Demo waves");
  const started = Date.now();
  await page.locator("#dome-image").setInputFiles(photo);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            ["ready", "fallback"].includes(window.dome.depthState) &&
            ["ready", "fallback"].includes(window.dome.featureState),
        ),
      { timeout: 180000, intervals: [100, 500, 1000] },
    )
    .toBe(true);
  const depth = await page.evaluate(() => ({
    state: window.dome.depthState,
    status: window.dome.depthStatus,
    error: window.dome.depthError,
    backend: window.dome.depthMap.backend,
    inferenceMs: window.dome.depthMap.inferenceMs,
    shape: [window.dome.depthMap.width, window.dome.depthMap.height],
    runs: window.dome.estimator.runs,
    workerActive: !!window.dome.estimator.pending,
  }));
  const mapsReadyMs = Date.now() - started;
  const initialFeature = await page.evaluate(() => ({
    state: window.dome.featureState,
    target: window.dome.featureMap.layer,
    shape: [window.dome.featureMap.height, window.dome.featureMap.width],
    inferenceMs: window.dome.featureMap.inferenceMs,
    retainedTensors: window.dome.featureMap.retainedTensors,
  }));
  assert.equal(depth.state, "ready", depth.error);
  assert.equal(depth.runs, 1);
  assert.equal(depth.workerActive, false);
  assert.equal(initialFeature.state, "ready");
  assert.equal(initialFeature.retainedTensors, 0);
  // No model inference is invoked in the following camera/render work.
  const ready = await measure("Photo with cached depth");
  const look = await measure("Photo during continuous mouselook", true);
  const targets = [];
  for (const selected of [1, 2]) {
    await page
      .getByLabel("DREAM TARGET", { exact: true })
      .selectOption(String(selected));
    await expect
      .poll(() => page.evaluate(() => window.dome.featureState), {
        timeout: 90000,
      })
      .toBe("ready");
    targets.push(await measure(`Cached feature target ${selected}`));
  }
  await page.evaluate(() => {
    window.dome.camera.reset();
    window.dome.onStateChange();
  });
  await page.screenshot({ path: path.join(output, "dome.png") });
  await page
    .locator("#output-canvas")
    .screenshot({ path: path.join(output, "front.png") });
  await page.evaluate(() => {
    window.dome.camera.look(-Math.PI / 0.006, 0);
    window.dome.onStateChange();
  });
  await page.waitForTimeout(150);
  await page
    .locator("#output-canvas")
    .screenshot({ path: path.join(output, "rear.png") });
  await page.locator("#toggle-fullscreen").click();
  await page.waitForFunction(
    () => document.fullscreenElement && window.dome.canvas.width > 768,
  );
  const fullscreen = await measure(
    "Fullscreen during continuous mouselook",
    true,
  );
  await page.screenshot({ path: path.join(output, "fullscreen.png") });
  const conditions = [demo, ready, look, ...targets, fullscreen];
  for (const row of conditions) {
    assert.equal(row.glError, 0);
    assert.ok(row.fps >= 55);
    assert.ok(row.drawFps >= 55);
    assert.equal(row.featureWorkerActive, false);
  }
  assert.equal(demo.runs, 0);
  assert.equal(ready.runs, 1);
  assert.equal(look.runs, 1);
  for (const row of targets) assert.equal(row.runs, 1);
  assert.deepEqual(errors, []);
  const feature = await page.evaluate(() => ({
    state: window.dome.featureState,
    runs: window.dome.featureEstimator.runs,
  }));
  assert.equal(feature.state, "ready");
  assert.equal(feature.runs, 3);
  assert.equal(ready.featureRuns, 1);
  assert.equal(look.featureRuns, 1);
  assert.equal(hardware.webgpu.isFallbackAdapter, false);
  const report = {
    hardware,
    photo,
    photoSource: photo.endsWith("verification-photo.jpg")
      ? "https://github.com/DepthAnything/Depth-Anything-V2/blob/main/assets/examples/demo01.jpg"
      : null,
    depth,
    mapsReadyMs,
    initialFeature,
    feature: await page.evaluate(() => ({
      state: window.dome.featureState,
      error: window.dome.featureError,
      shape: [window.dome.featureMap.height, window.dome.featureMap.width],
      inferenceMs: window.dome.featureMap.inferenceMs,
      retainedTensors: window.dome.featureMap.retainedTensors,
      runs: window.dome.featureEstimator.runs,
      workerActive: !!window.dome.featureEstimator.pending,
    })),
    conditions,
    downloads,
    errors,
    notes: [
      "Display cadence is limited by the 60 Hz test environment; higher refresh rates are not claimed.",
      "Chromium uses Vulkan and unsafe WebGPU flags for the native AMD adapter in this local benchmark; default browser backends may differ.",
      "Depth inference is measured separately from download, preprocessing, session initialization and cleanup.",
      "Rendering uses cached depth and feature maps with analytic waves; inference workers terminate after each result.",
    ],
  };
  await writeFile(
    path.join(output, "timing.json"),
    JSON.stringify(report, null, 2),
  );
  const rows = report.conditions
    .map(
      (r) =>
        `<tr><td>${r.label}</td><td>${r.fps.toFixed(1)}</td><td>${r.drawFps.toFixed(1)}</td><td>${r.p95Ms.toFixed(1)} / ${r.p99Ms.toFixed(1)}</td><td>${r.maxMs.toFixed(1)}</td><td>${r.runs}</td><td>${r.longTasks.length}</td></tr>`,
    )
    .join("");
  await writeFile(
    path.join(output, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Cortical Dream Dome verification</title><style>body{font:16px system-ui;background:#101218;color:#e4e8ed;margin:24px}table{border-collapse:collapse}td,th{padding:10px;border:1px solid #555;text-align:left}img{max-width:100%}a{color:#9cf}</style><h1>3D Cortical Dream Dome</h1><p>${hardware.renderer} · ${hardware.canvas.join("×")} canvas · 65,536 vertices</p><p>One-shot depth: ${depth.backend}, ${Math.round(depth.inferenceMs)} ms inference; ${mapsReadyMs} ms until both maps were ready, including download and initialization. Inception: ${Math.round(initialFeature.inferenceMs)} ms forward inference (${initialFeature.shape.join("×")} map).</p><table><tr><th>Condition</th><th>Display FPS</th><th>Draw FPS</th><th>p95 / p99 ms</th><th>Max ms</th><th>Total depth runs</th><th>Long tasks</th></tr>${rows}</table><ul>${report.notes.map((n) => `<li>${n}</li>`).join("")}</ul><p><a href="timing.json">Full measurements</a></p><img src="dome.png" alt="A photo inside a sphere displaced by depth, a neuron activation map and cortical waves"><h2>Front and mirrored rear</h2><img src="front.png" width="480" alt="Front view"><img src="rear.png" width="480" alt="Mirrored rear view">`,
  );
  console.log(
    JSON.stringify(
      {
        hardware,
        depth,
        conditions: report.conditions.map(
          ({ intervals: _intervals, ...r }) => r,
        ),
        errors,
      },
      null,
      2,
    ),
  );
  console.log(`Saved verification: ${output}`);
} finally {
  await browser.close();
}
