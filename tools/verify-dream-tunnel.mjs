// Native-GPU rendered views, continuity, bounded resources and one real model run.
// node tools/verify-dream-tunnel.mjs [--skip-live]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { createDreamTunnelServer } from "./serve-dream-tunnel.mjs";
import { buildDreamTunnel } from "./build-dream-tunnel.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  output = path.join(root, "test-results/dream-drift-tunnel");
await buildDreamTunnel(output);
const hash = (b) => createHash("sha256").update(b).digest("hex");
const savedFiles = [];
for (let photo = 1; photo <= 3; photo++)
  for (let level = 0; level <= 6; level++)
    for (const neon of [false, true])
      savedFiles.push(
        level
          ? `photo-${photo}-progression-mixed-${level}${neon ? "-neon" : ""}.png`
          : `photo-${photo}-${neon ? "progression-baseline-neon" : "migan"}.png`,
      );
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      savedFiles.map(async (file) => [
        file,
        hash(
          await readFile(
            path.join(root, "test-results/dream-drift-neon-progression", file),
          ),
        ),
      ]),
    ),
  );
const before = await hashes(),
  server = await createDreamTunnelServer(root, output);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  args: [
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=vulkan",
    "--enable-features=Vulkan",
    "--enable-gpu",
  ],
});
const page = await browser.newPage({ viewport: { width: 1250, height: 1150 } }),
  errors = [],
  captures = [];
page.on("pageerror", (e) => errors.push(e.message));
const report = {
  status: "running",
  date: new Date().toISOString(),
  captures,
  errors,
  limits: {
    routeTilePlaces: 64,
    activeSegments: 7,
    gpuTextures: 5,
    generatedCachePlaces: 6,
    savedImageStages: 7,
  },
};
try {
  for (const photo of [3, 1, 2]) {
    await page.goto(
      `${base}/tunnel/${photo === 3 ? "index.html" : `photo-${photo}.html`}`,
    );
    await page.waitForFunction(() => window.experimentReady);
    await page.evaluate(() => {
      window.experiment.automation = true;
    });
    await page.uncheck("#live");
    for (const [level, parameter] of [0, 1.5, 3.5, 5.5, 8.5, 12.5].entries()) {
      const stats = await page.evaluate(
        async ({ parameter }) => {
          const e = window.experiment;
          e.seek(parameter);
          await new Promise((r) => setTimeout(r, 0));
          for (let i = 0; i < 8; i++) e.journey.update(0.1);
          e.draw(4);
          const a = e.renderer.pixels();
          e.draw(4);
          const b = e.renderer.pixels();
          if (!a.every((v, i) => v === b[i]))
            throw new Error("Paused frame changed");
          let sum = 0,
            dark = 0;
          for (let i = 0; i < a.length; i += 4) {
            sum += a[i] + a[i + 1] + a[i + 2];
            if (a[i] + a[i + 1] + a[i + 2] < 20) dark++;
          }
          if (e.renderer.gl.getError()) throw new Error("WebGL error");
          return {
            resources: e.renderer.stats,
            meanByte: sum / (a.length * 0.75),
            darkFraction: dark / (a.length * 0.25),
            profile: e.journey.snapshot().profile,
          };
        },
        { parameter },
      );
      assert.ok(stats.meanByte > 18 && stats.meanByte < 235);
      assert.ok(stats.darkFraction < 0.25);
      assert.ok(stats.resources.meshes <= 50);
      const file = `photo-${photo}-depth-${level + 1}.png`;
      await page.locator("#view").screenshot({ path: path.join(output, file) });
      captures.push({ photo, level: level + 1, file, ...stats });
    }
  }
  // Use the small image for settings, reverse/rebase continuity and live generation.
  await page.goto(`${base}/tunnel/`);
  await page.waitForFunction(() => window.experimentReady);
  await page.evaluate(() => {
    window.experiment.automation = true;
  });
  await page.uncheck("#live");
  report.settings = await page.evaluate(async () => {
    const e = window.experiment,
      r = e.renderer;
    e.seek(8.5);
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 8; i++) e.journey.update(0.1);
    let combinations = 0;
    for (let style = 0; style < 6; style++)
      for (const opacity of [0, 0.54, 0.9])
        for (const inversion of [0, 0.65, 1]) {
          Object.assign(r.settings, { archStyle: style, opacity, inversion });
          e.draw(5);
          if (r.gl.getError()) throw new Error("Settings GL error");
          combinations++;
        }
    Object.assign(r.settings, {
      archStyle: -1,
      opacity: 0.54,
      inversion: 0.65,
    });
    return { combinations, glyphs: r.glyphs };
  });
  assert.equal(new Set(report.settings.glyphs.trim()).size, 16);
  for (let style = 0; style < 6; style++) {
    await page.selectOption("#arch", String(style));
    await page.evaluate(() => window.experiment.draw(5));
    const file = `gateway-${style}.png`;
    await page.locator("#view").screenshot({ path: path.join(output, file) });
  }
  await page.selectOption("#arch", "-1");
  report.continuity = await page.evaluate(async () => {
    const e = window.experiment,
      r = e.renderer,
      checks = [];
    for (const boundary of [1, 2, 6, 64]) {
      e.seek(boundary - 0.001);
      await new Promise((r) => setTimeout(r, 0));
      for (let i = 0; i < 15; i++) e.journey.update(0.1);
      e.draw(5);
      const a = r.pixels();
      e.journey.parameter = boundary + 0.001;
      e.draw(5);
      const b = r.pixels();
      let delta = 0;
      for (let i = 0; i < a.length; i++)
        if (i % 4 !== 3) delta += Math.abs(a[i] - b[i]);
      const forwardMean = delta / (a.length * 0.75);
      e.journey.parameter = boundary - 0.001;
      e.draw(5);
      const c = r.pixels();
      let reverseDelta = 0;
      for (let i = 0; i < a.length; i++)
        if (i % 4 !== 3) reverseDelta += Math.abs(a[i] - c[i]);
      checks.push({
        boundary,
        forwardMean,
        reverseMean: reverseDelta / (a.length * 0.75),
      });
    }
    return checks;
  });
  for (const c of report.continuity) {
    assert.ok(c.forwardMean < 12, JSON.stringify(c));
    assert.ok(c.reverseMean < 0.2, JSON.stringify(c));
  }
  report.longRoute = await page.evaluate(() => {
    const e = window.experiment;
    let maxMeshes = 0;
    // Representative distant windows, including a million places from the start.
    for (let n = 0; n < 160; n++) {
      e.journey.parameter = n * 6289 + 0.4;
      e.draw(6);
      maxMeshes = Math.max(maxMeshes, e.renderer.stats.meshes);
      if (e.renderer.gl.getError()) throw new Error("Long-route GL error");
    }
    return {
      windows: 160,
      finalPlace: e.journey.snapshot().node,
      resources: e.renderer.stats,
      maxMeshes,
    };
  });
  assert.ok(report.longRoute.maxMeshes <= 50);
  assert.equal(report.longRoute.resources.textures, 5);
  // Exercise the visible loading hold, cancellation and cached-image recovery.
  await page.selectOption("#delay", "1.5");
  await page.evaluate(() => {
    const e = window.experiment;
    e.seek(2.87);
    for (let i = 0; i < 60; i++) e.journey.update(0.1, 1);
    e.draw(7);
  });
  assert.equal(await page.locator("#loading").isVisible(), true);
  await page
    .locator("#view")
    .screenshot({ path: path.join(output, "loading-threshold.png") });
  await page.click("#home");
  await page.waitForTimeout(1600);
  assert.equal(
    await page.evaluate(() => window.experiment.journey.parameter),
    0,
  );
  await page.selectOption("#delay", "0");
  report.cancellation =
    "Return to entrance cancels pending preparation without moving the camera later.";
  await page.exposeFunction("saveTunnelRecording", async (base64) =>
    writeFile(
      path.join(output, "walkthrough.webm"),
      Buffer.from(base64, "base64"),
    ),
  );
  report.recording = await page.evaluate(async () => {
    const e = window.experiment,
      canvas = document.getElementById("view");
    e.seek(2.4);
    e.journey.speed = 7;
    const stream = canvas.captureStream(30),
      chunks = [],
      recorder = new MediaRecorder(stream, {
        mimeType: "video/webm;codecs=vp9",
        videoBitsPerSecond: 5000000,
      });
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    recorder.start();
    await new Promise((resolve) => {
      const start = performance.now();
      let previous = start;
      function frame(now) {
        const dt = Math.max(0, Math.min(0.1, (now - previous) / 1000));
        previous = now;
        e.journey.update(dt, 1);
        e.draw((now - start) / 1000);
        if (now - start < 10000) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(chunks, { type: recorder.mimeType });
    const base64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.readAsDataURL(blob);
    });
    await window.saveTunnelRecording(base64);
    e.journey.speed = 3;
    return {
      file: "walkthrough.webm",
      seconds: 10,
      fromPlace: 2.4,
      toPlace: e.journey.parameter,
      bytes: blob.size,
    };
  });
  // Fixed-camera GPU time, including walls, floor, echoes and finest hex.
  report.performance = await page.evaluate(async () => {
    const e = window.experiment,
      r = e.renderer,
      gl = r.gl;
    e.seek(12.5);
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 10; i++) e.journey.update(0.1);
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2"),
      debug = gl.getExtension("WEBGL_debug_renderer_info"),
      gpu = debug
        ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER);
    if (!ext) return { gpu, gpuTimerSupported: false };
    const samples = [];
    for (let i = 0; i < 32; i++) {
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      e.draw(4 + i * 0.016);
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      gl.flush();
      const deadline = performance.now() + 4000;
      while (
        !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) &&
        performance.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 8));
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE))
        throw new Error("GPU timer timed out");
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT) && i > 5)
        samples.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
    samples.sort((a, b) => a - b);
    return {
      gpu,
      gpuTimerSupported: true,
      width: 1120,
      height: 700,
      samples: samples.length,
      medianMs: samples[Math.floor(samples.length * 0.5)],
      p95Ms: samples[Math.floor(samples.length * 0.95)],
    };
  });
  if (!process.argv.includes("--skip-live")) {
    console.log(
      "Testing live local Inception generation while the tunnel holds at its threshold…",
    );
    await page.check("#live");
    await page.evaluate(() => {
      const e = window.experiment;
      e.seek(4.87);
      for (let i = 0; i < 60; i++) e.journey.update(0.1, 1);
      e.draw(8);
    });
    await page.waitForFunction(
      () => window.experiment.generated > 0 || window.experiment.journey.error,
      null,
      { timeout: 180000 },
    );
    report.live = await page.evaluate(() => {
      const e = window.experiment;
      if (e.journey.error) throw new Error(e.journey.error);
      const held = e.journey.parameter;
      for (let i = 0; i < 30; i++) e.journey.update(0.1, 1);
      e.draw(9);
      return {
        held,
        resumed: e.journey.parameter,
        generated: e.generated,
        metrics: e.lastMetrics,
        cache: e.cache.size,
        resources: e.renderer.stats,
        glError: e.renderer.gl.getError(),
      };
    });
    assert.ok(Math.abs(report.live.held - 4.88) < 0.0001);
    assert.ok(report.live.resumed > 5);
    assert.ok(report.live.metrics.meanChangedByte > 0.01);
    assert.equal(report.live.metrics.retainedTensors, 0);
    assert.equal(report.live.glError, 0);
    await page
      .locator("#view")
      .screenshot({ path: path.join(output, "live-generated.png") });
    // Cancel the following job and dispose the persistent worker.
    await page.click("#home");
    await page.uncheck("#live");
  }
  // Offline playback remains useful without a local server or workers.
  await page.goto(pathToFileURL(path.join(output, "index.html")).href);
  await page.waitForFunction(() => window.experimentReady);
  assert.equal(await page.locator("#live").isDisabled(), true);
  report.offline =
    "Portable gallery loads and plays saved model images without a server.";
  await page.click("#home");
  await page.locator("#view").focus();
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(350);
  await page.keyboard.up("KeyW");
  const moved = await page.evaluate(() => window.experiment.journey.parameter);
  assert.ok(moved > 0.01);
  await page.keyboard.press("Space");
  assert.equal(await page.evaluate(() => window.experiment.auto), true);
  await page.keyboard.press("Space");
  assert.equal(await page.evaluate(() => window.experiment.auto), false);
  await page.uncheck("#map-toggle");
  assert.equal(await page.locator("#map").isHidden(), true);
  await page.check("#map-toggle");
  report.controls =
    "Keyboard movement, Space auto-walk toggle, home, depth jumps, gateway selection and map visibility passed.";
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  report.mobile = "390px viewport has no horizontal overflow.";
  assert.deepEqual(await hashes(), before);
  report.savedImages = {
    count: savedFiles.length,
    sha256: before,
    unchanged: true,
  };
  assert.deepEqual(errors, []);
  report.status = "complete";
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await writeFile(
    path.join(root, "verification/dream-drift-tunnel.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        status: report.status,
        views: captures.length,
        performance: report.performance,
        live: report.live,
        continuity: report.continuity,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
