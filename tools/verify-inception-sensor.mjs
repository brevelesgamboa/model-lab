// Start npm run dev, then: node tools/verify-inception-sensor.mjs [url] [output]
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const url = process.argv[2] || "http://127.0.0.1:8081";
const output = path.resolve(
  process.argv[3] || "test-results/inception-sensor-hardware",
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=gl", "--enable-gpu"],
});
const errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.abort(),
  );
  await page.goto(url);
  await page.evaluate(async () => {
    const { TextureNcaRuntime } =
      await import("/assets/js/models/neural-growth/runtime.js");
    const draw = TextureNcaRuntime.prototype.draw;
    TextureNcaRuntime.prototype.draw = function (...args) {
      window.sensorRuntime = this;
      return draw.apply(this, args);
    };
    TextureNcaRuntime.prototype.readPhenotypeRgb = () => {
      throw new Error("Sensor used synchronous phenotype readback");
    };
    const { inceptionSensor: sensor } =
      await import("/assets/js/models/neural-growth/inception-sensor.js");
    window.sensor = sensor;
    window.sensorSamples = [];
    const receive = sensor.onMessage.bind(sensor);
    sensor.onMessage = (message) => {
      const count = sensor.inferenceCount;
      receive(message);
      if (sensor.inferenceCount !== count)
        window.sensorSamples.push({
          at: performance.now(),
          ...sensor.getStats(),
        });
    };
  });
  await page.locator("#model-select").selectOption("neural-growth");
  await page.locator("#step-growth").waitFor({ state: "visible" });
  await page
    .getByLabel("PATTERN", { exact: true })
    .selectOption("membrane-field");
  const control = page.locator('[data-parameter="rotation"]');
  await control.evaluate((element) => {
    for (let p = element.parentElement; p; p = p.parentElement)
      if (p.tagName === "DETAILS") p.open = true;
  });
  await control.locator(".modulation-toggle").click();
  const drawer = control.locator(".modulation-drawer");
  await page.locator("#toggle-animation").click();
  await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  });
  const hardware = await page.evaluate(() => {
    const gl = window.sensorRuntime.gl,
      ext = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      renderer: gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL || gl.RENDERER),
      size: window.sensorRuntime.size,
      pattern: window.sensorRuntime.model.id,
      canvas: [
        document.getElementById("output-canvas").width,
        document.getElementById("output-canvas").height,
      ],
    };
  });

  async function measure(label, milliseconds = 12000) {
    return page.evaluate(
      async ({ label, milliseconds }) => {
        const start = performance.now(),
          firstStep = window.sensorRuntime.steps,
          samples = window.sensorSamples.length;
        let last = start;
        const intervals = [],
          longTasks = [];
        const observer = new PerformanceObserver((list) =>
          longTasks.push(
            ...list.getEntries().map((entry) => ({
              start: entry.startTime - start,
              duration: entry.duration,
            })),
          ),
        );
        observer.observe({ entryTypes: ["longtask"] });
        await new Promise((resolve) => {
          const tick = () => {
            const now = performance.now();
            intervals.push(now - last);
            last = now;
            if (now - start < milliseconds) requestAnimationFrame(tick);
            else resolve();
          };
          requestAnimationFrame(tick);
        });
        observer.disconnect();
        return {
          label,
          elapsedMs: performance.now() - start,
          intervals,
          longTasks,
          steps: window.sensorRuntime.steps - firstStep,
          samples: window.sensorSamples.slice(samples),
          stats: window.sensor.getStats(),
          glError: window.sensorRuntime.gl.getError(),
          audioStatus:
            document.getElementById("toggle-audio-input").textContent,
          effectiveRotation: window.sensorRuntime.rotation,
        };
      },
      { label, milliseconds },
    );
  }
  const baseline = await measure("No sensor");
  await drawer.getByRole("button", { name: "Inception", exact: true }).click();
  const cold = await measure("Sensor loading and first samples", 4000);
  await page.evaluate(async () => {
    const deadline = performance.now() + 60000;
    while (
      window.sensor.samples < 4 &&
      !window.sensor.error &&
      performance.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (window.sensor.error || window.sensor.samples < 4)
      throw new Error(window.sensor.error || "Sensor timeout");
  });
  const stem = await measure("Conv2d_4a_3x3:42");
  await page.screenshot({ path: path.join(output, "sensor-route.png") });
  await drawer.locator('[data-field="sensorLayer"]').selectOption("mixed_5b");
  await drawer.locator('[data-field="sensorChannel"]').fill("120");
  await drawer.locator('[data-field="sensorChannel"]').dispatchEvent("change");
  await page.evaluate(async () => {
    const deadline = performance.now() + 60000;
    while (
      window.sensor.samples < 3 &&
      !window.sensor.error &&
      performance.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (window.sensor.error || window.sensor.samples < 3)
      throw new Error(window.sensor.error || "Target change timeout");
  });
  const mixed = await measure("mixed_5b:120");
  const percentile = (values, p) => {
    const sorted = [...values].sort((a, b) => a - b);
    return (
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? null
    );
  };
  for (const row of [baseline, cold, stem, mixed]) {
    Object.assign(row, {
      fps: (row.intervals.length * 1000) / row.elapsedMs,
      updatesPerSecond: (row.steps * 1000) / row.elapsedMs,
      frameP50Ms: percentile(row.intervals, 0.5),
      frameP95Ms: percentile(row.intervals, 0.95),
      frameP99Ms: percentile(row.intervals, 0.99),
      frameMaxMs: Math.max(...row.intervals),
      inferenceP50Ms: percentile(
        row.samples.map((s) => s.inferenceMs),
        0.5,
      ),
      captureP95Ms: percentile(
        row.samples.map((s) => s.captureMs),
        0.95,
      ),
    });
    assert.equal(row.glError, 0);
    assert.ok(
      row.samples.every(
        (sample) =>
          sample.downloadedValues === 1 &&
          sample.retainedTensors === 0 &&
          sample.level >= 0 &&
          sample.level <= 1,
      ),
    );
    for (let i = 1; i < row.samples.length; i++)
      assert.ok(
        row.samples[i].lastRun - row.samples[i - 1].lastRun >= 500 - 1e-5,
      );
  }
  assert.ok(stem.samples.length >= 20 && mixed.samples.length >= 20);
  assert.ok([...stem.samples, ...mixed.samples].some((s) => s.level > 0.01));
  assert.ok(
    stem.effectiveRotation > 0 || mixed.effectiveRotation > 0,
    "The live rotation route did not reach the simulation.",
  );
  assert.deepEqual(errors, []);
  const result = {
    hardware,
    conditions: [baseline, cold, stem, mixed],
    errors,
    notes: [
      "Production UI, actual RX GPU, asynchronous worker inference; display heartbeat uses performance.now() so delayed callbacks count as long frames.",
      "No shader or simulation stepping code is changed by the sensor. Rotation modulation changes the existing perception parameter.",
      "Baseline and both targets run sequentially on the same live Membrane Field. These are timing comparisons, not matched image rollouts.",
      "Cold startup is reported separately from warmed inference.",
    ],
  };
  await writeFile(
    path.join(output, "timing.json"),
    JSON.stringify(result, null, 2),
  );
  const rows = result.conditions
    .map(
      (r) =>
        `<tr><td>${r.label}</td><td>${r.fps.toFixed(1)}</td><td>${r.updatesPerSecond.toFixed(1)}</td><td>${r.frameP95Ms.toFixed(1)} / ${r.frameP99Ms.toFixed(1)}</td><td>${r.frameMaxMs.toFixed(1)}</td><td>${r.inferenceP50Ms?.toFixed(1) || "—"}</td><td>${r.captureP95Ms?.toFixed(1) || "—"}</td><td>${r.longTasks.length}</td></tr>`,
    )
    .join("");
  await writeFile(
    path.join(output, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Inception sensor verification</title><style>body{font:16px system-ui;background:#101218;color:#e4e8ed;margin:24px}td,th{padding:10px;border:1px solid #555;text-align:left}table{border-collapse:collapse}img{max-width:100%}a{color:#9cf}</style><h1>Forward-only Inception sensor</h1><p>${hardware.renderer} · ${hardware.pattern} · ${hardware.size}×${hardware.size} cells · production canvas ${hardware.canvas.join("×")}</p><table><tr><th>Condition</th><th>FPS</th><th>NCA updates/sec</th><th>p95 / p99 frame ms</th><th>Max frame ms</th><th>Median inference ms</th><th>p95 snapshot ms</th><th>Main-thread long tasks</th></tr>${rows}</table><p>One scalar downloaded per sample; no retained tensors or WebGL errors. Samples start no faster than every 500 ms.</p><ul>${result.notes.map((n) => `<li>${n}</li>`).join("")}</ul><p><a href="timing.json">Full timing and signal measurements</a></p><img src="sensor-route.png" alt="Live Membrane Field with Inception routing controls">`,
  );
  console.log(
    JSON.stringify(
      {
        hardware,
        conditions: result.conditions.map(
          ({ intervals: _intervals, samples, ...row }) => ({
            ...row,
            samples: samples.length,
          }),
        ),
      },
      null,
      2,
    ),
  );
  console.log(`Saved sensor verification: ${output}`);
} finally {
  await browser.close();
}
