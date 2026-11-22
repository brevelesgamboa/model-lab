// npm run dev; node tools/verify-dome-structure.mjs [url] [output]
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const url = process.argv[2] || "http://127.0.0.1:8082";
const output = path.resolve(
  process.argv[3] || "test-results/dome-structure-hardware",
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
      const r = await render.apply(this, args);
      window.domeDraws++;
      return r;
    };
  });
  await page.locator("#model-select").selectOption("cortical-dream-dome");
  await page.waitForFunction(() => !!window.dome?.graphics);
  await page
    .locator("#dome-image")
    .setInputFiles("models/neural-growth/previews/rock-surface.png");
  await expect
    .poll(
      () =>
        page.evaluate(() => [window.dome.depthState, window.dome.featureState]),
      { timeout: 180000 },
    )
    .toEqual(["ready", "ready"]);
  const renderer = await page.evaluate(() => {
    const gl = window.dome.gl,
      e = gl.getExtension("WEBGL_debug_renderer_info");
    return gl.getParameter(e?.UNMASKED_RENDERER_WEBGL || gl.RENDERER);
  });
  await page.getByLabel("DREAM TARGET", { exact: true }).selectOption("2");
  await expect
    .poll(() => page.evaluate(() => window.dome.featureState), {
      timeout: 120000,
    })
    .toBe("ready");
  await page
    .locator("#output-canvas")
    .screenshot({ path: path.join(output, "before.png") });
  const started = Date.now();
  await page.locator("#dome-generate").click();
  await expect
    .poll(() => page.evaluate(() => window.dome.bakeState), { timeout: 180000 })
    .toBe("ready");
  const totalBakeMs = Date.now() - started;
  const luma = await page.evaluate(() => {
    const d = window.dome,
      w = d.panorama.width,
      h = d.panorama.height;
    const a = d.seed360.getContext("2d").getImageData(0, 0, w, h).data,
      b = d.panorama.getContext("2d").getImageData(0, 0, w, h).data;
    const chroma = (p, i) => [
      -0.168736 * p[i] - 0.331264 * p[i + 1] + 0.5 * p[i + 2],
      0.5 * p[i] - 0.418688 * p[i + 1] - 0.081312 * p[i + 2],
    ];
    let maxChroma = 0,
      sum = 0,
      change = 0;
    for (let i = 0; i < a.length; i += 4) {
      const ac = chroma(a, i),
        bc = chroma(b, i);
      for (let c = 0; c < 2; c++) {
        const delta = Math.abs(ac[c] - bc[c]);
        maxChroma = Math.max(maxChroma, delta);
        sum += delta;
      }
      for (let c = 0; c < 3; c++) change += Math.abs(a[i + c] - b[i + c]);
    }
    return {
      maxChromaByte: maxChroma,
      meanChromaByte: sum / (w * h * 2),
      meanRgbChangeByte: change / (w * h * 3),
      retention: d.colorRetention,
      bake: d.bakeMetrics,
      glError: d.gl.getError(),
    };
  });
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
    await expect(page.locator("#render-state")).toHaveText("FRAME READY");
    await page.waitForTimeout(100);
    await page
      .locator("#output-canvas")
      .screenshot({ path: path.join(output, `${name}.png`) });
  }
  const panorama = await page.evaluate(async () => {
    const blob = await window.dome.panorama.convertToBlob();
    return await new Promise((r) => {
      const reader = new FileReader();
      reader.onload = () => r(reader.result.split(",")[1]);
      reader.readAsDataURL(blob);
    });
  });
  await writeFile(
    path.join(output, "dream-texture.png"),
    Buffer.from(panorama, "base64"),
  );
  await page.locator("#dome-reset-view").click();
  await page.locator("#toggle-animation").click();
  async function measure(label) {
    const row = await page.evaluate(async () => {
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
          const t = performance.now();
          intervals.push(t - last);
          last = t;
          window.dome.camera.look(-1, 0);
          if (t - start < 4000) requestAnimationFrame(tick);
          else resolve();
        }
        requestAnimationFrame(tick);
      });
      observer.disconnect();
      return {
        elapsedMs: performance.now() - start,
        draws: window.domeDraws - first,
        intervals,
        longTasks,
        size: [window.dome.canvas.width, window.dome.canvas.height],
        glError: window.dome.gl.getError(),
      };
    });
    const sorted = [...row.intervals].sort((a, b) => a - b);
    return {
      label,
      ...row,
      drawFps: (row.draws * 1000) / row.elapsedMs,
      p99Ms: sorted[Math.floor(sorted.length * 0.99)],
    };
  }
  const conditions = [await measure("Mirrored luminance Dream")];
  const aiStarted = Date.now();
  await page.locator("#dome-outpainting").selectOption("migan");
  await expect(page.locator("#dome-migan-status")).toContainText(
    "MI-GAN Ready",
    { timeout: 180000 },
  );
  const migan = await page.evaluate(() => ({
    info: window.dome.inpaintInfo,
    mode: window.dome.outpaintingMode,
    glError: window.dome.gl.getError(),
  }));
  migan.totalMs = Date.now() - aiStarted;
  await page.locator("#dome-reset-view").click();
  await page.screenshot({ path: path.join(output, "migan.png") });
  await page.evaluate(() => {
    window.dome.camera.yaw = Math.PI;
    window.dome.onStateChange();
  });
  await page.waitForTimeout(100);
  await page
    .locator("#output-canvas")
    .screenshot({ path: path.join(output, "migan-rear.png") });
  conditions.push(await measure("MI-GAN panorama"));
  await page.locator("#dome-generate").click();
  await expect
    .poll(() => page.evaluate(() => window.dome.bakeState), { timeout: 180000 })
    .toBe("ready");
  migan.dream = await page.evaluate(() => ({
    bake: window.dome.bakeMetrics,
    mode: window.dome.outpaintingMode,
    glError: window.dome.gl.getError(),
  }));
  await page.locator("#dome-reset-view").click();
  await page.screenshot({ path: path.join(output, "migan-dream.png") });
  await page.evaluate(() => {
    window.dome.camera.yaw = Math.PI;
    window.dome.onStateChange();
  });
  await page.waitForTimeout(100);
  await page
    .locator("#output-canvas")
    .screenshot({ path: path.join(output, "migan-dream-rear.png") });
  await page.locator("#dome-outpainting").selectOption("mirrored");
  const warm = Date.now();
  await page.locator("#dome-outpainting").selectOption("migan");
  await expect(page.locator("#dome-migan-status")).toContainText(
    "MI-GAN Ready",
    { timeout: 180000 },
  );
  migan.memoryReuseMs = Date.now() - warm;
  await page.locator("#toggle-fullscreen").click();
  await page.waitForFunction(
    () => document.fullscreenElement && window.dome.canvas.width > 768,
  );
  conditions.push(await measure("Fullscreen MI-GAN panorama"));
  const report = {
    renderer,
    photo: "models/neural-growth/previews/rock-surface.png",
    totalBakeMs,
    luma,
    migan,
    conditions,
    errors,
    notes: [
      "Native Vulkan/WebGPU Chromium flags; 60 Hz display.",
      "Source rock image is an existing NCA gallery preview.",
      "Luminance-only prevents new chroma; recognizable arches or other motifs are not guaranteed.",
      "MI-GAN does not reconstruct a true 360 scene; seam/pole constraints enforce continuity.",
    ],
  };
  await cp(
    "models/neural-growth/previews/rock-surface.png",
    path.join(output, "source.png"),
  );
  await writeFile(
    path.join(output, "timing.json"),
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    path.join(output, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Dome structural Dream verification</title><style>body{font:16px system-ui;background:#11151c;color:#eee;margin:24px}img{max-width:100%}.view{width:32%}a{color:#9cf}</style><h1>Mirrored luminance Dream + optional MI-GAN</h1><p>${renderer}</p><p>15-step Dream: ${(luma.bake.bakeMs / 1000).toFixed(2)} s synthesis, ${(totalBakeMs / 1000).toFixed(2)} s total. Maximum chroma error: ${luma.maxChromaByte.toFixed(3)}/255.</p><p><a href="timing.json">Measurements</a></p><h2>Source / before / after</h2><img src="source.png" alt="Source rock preview"><img class="view" src="before.png" alt="Before Dream"><img class="view" src="front.png" alt="After luminance Dream"><h2>360 views</h2>${["right", "rear", "left", "ceiling", "floor"].map((n) => `<img class="view" src="${n}.png" alt="${n}">`).join("")}<h2>AI panorama / with Dream</h2><img class="view" src="migan-rear.png" alt="AI rear"><img class="view" src="migan-dream-rear.png" alt="AI rear with Dream"><img src="migan.png" alt="MI-GAN panorama"><img src="migan-dream.png" alt="MI-GAN plus luminance Dream"><ul>${report.notes.map((n) => `<li>${n}</li>`).join("")}</ul>`,
  );
  console.log(
    JSON.stringify(
      {
        ...report,
        conditions: conditions.map(({ intervals: _intervals, ...r }) => r),
      },
      null,
      2,
    ),
  );
  assert.ok(luma.maxChromaByte < 1.1);
  assert.ok(luma.meanRgbChangeByte > 1);
  assert.equal(luma.bake.retainedTensors, 0);
  assert.equal(luma.glError, 0);
  assert.equal(migan.mode, "migan");
  assert.equal(migan.dream.bake.retainedTensors, 0);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
