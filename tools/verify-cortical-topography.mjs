// npm run dev; node tools/verify-cortical-topography.mjs [photo] [url] [output]
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const photo = path.resolve(
  process.argv[2] || "models/neural-growth/previews/xeno-reef.png",
);
const url = process.argv[3] || "http://127.0.0.1:8081";
const output = path.resolve(
  process.argv[4] || "test-results/cortical-topography-hardware",
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
    const { CorticalTopographyModel } =
      await import("/assets/js/models/cortical-topography.js");
    const render = CorticalTopographyModel.prototype.render;
    window.topographyDraws = 0;
    CorticalTopographyModel.prototype.render = async function (...args) {
      window.topography = this;
      const result = await render.apply(this, args);
      window.topographyDraws++;
      return result;
    };
  });
  await page.locator("#model-select").selectOption("cortical-topography");
  await page.waitForFunction(() => window.topography?.graphics);
  await page.locator("#toggle-animation").click();
  const hardware = await page.evaluate(async () => {
    const gl = window.topography.gl,
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
  async function measure(label, orbit = false) {
    const result = await page.evaluate(
      async ({ label, orbit }) => {
        const start = performance.now(),
          firstDraw = window.topographyDraws;
        let last = start;
        const intervals = [],
          longTasks = [];
        const observer = new PerformanceObserver((list) =>
          longTasks.push(
            ...list
              .getEntries()
              .map((e) => ({
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
            if (orbit)
              window.topography.camera.orbit(0.5, Math.sin(now * 0.002) * 0.1);
            if (now - start < 10000) requestAnimationFrame(tick);
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
          draws: window.topographyDraws - firstDraw,
          runs: window.topography.estimator.runs,
          workerActive: !!window.topography.estimator.pending,
          glError: window.topography.gl.getError(),
        };
      },
      { label, orbit },
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
  await page.locator("#cortical-image").setInputFiles(photo);
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          ["ready", "fallback"].includes(window.topography.depthState),
        ),
      { timeout: 180000, intervals: [100, 500, 1000] },
    )
    .toBe(true);
  const depth = await page.evaluate(() => ({
    state: window.topography.depthState,
    status: window.topography.depthStatus,
    error: window.topography.depthError,
    backend: window.topography.depthMap.backend,
    inferenceMs: window.topography.depthMap.inferenceMs,
    shape: [
      window.topography.depthMap.width,
      window.topography.depthMap.height,
    ],
    runs: window.topography.estimator.runs,
    workerActive: !!window.topography.estimator.pending,
  }));
  depth.totalMs = Date.now() - started;
  assert.equal(depth.state, "ready", depth.error);
  assert.equal(depth.runs, 1);
  assert.equal(depth.workerActive, false);
  // No model inference is invoked in the following camera/render work.
  const ready = await measure("Photo with cached depth");
  const orbit = await measure("Photo during continuous orbit", true);
  await page.screenshot({ path: path.join(output, "topography.png") });
  for (const row of [demo, ready, orbit]) {
    assert.equal(row.glError, 0);
    assert.ok(row.fps >= 55);
  }
  assert.equal(demo.runs, 0);
  assert.equal(ready.runs, 1);
  assert.equal(orbit.runs, 1);
  assert.deepEqual(errors, []);
  const report = {
    hardware,
    photo,
    depth,
    conditions: [demo, ready, orbit],
    downloads,
    errors,
    notes: [
      "Display cadence is limited by the 60 Hz test environment; 120 FPS is not claimed.",
      "Depth inference is measured separately from download, preprocessing, session initialization and cleanup.",
      "Rendering uses the cached depth map and analytic waves; the worker is terminated after its one result.",
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
    `<!doctype html><meta charset="utf-8"><title>Cortical Topography verification</title><style>body{font:16px system-ui;background:#101218;color:#e4e8ed;margin:24px}table{border-collapse:collapse}td,th{padding:10px;border:1px solid #555;text-align:left}img{max-width:100%}a{color:#9cf}</style><h1>3D Cortical Topography</h1><p>${hardware.renderer} · ${hardware.canvas.join("×")} canvas · 65,536 vertices</p><p>One-shot depth: ${depth.backend}, ${Math.round(depth.inferenceMs)} ms inference; ${depth.totalMs} ms including download and initialization.</p><table><tr><th>Condition</th><th>Display FPS</th><th>Draw FPS</th><th>p95 / p99 ms</th><th>Max ms</th><th>Total depth runs</th><th>Long tasks</th></tr>${rows}</table><ul>${report.notes.map((n) => `<li>${n}</li>`).join("")}</ul><p><a href="timing.json">Full measurements</a></p><img src="topography.png" alt="A photo displaced by relative depth and cortical waves">`,
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
