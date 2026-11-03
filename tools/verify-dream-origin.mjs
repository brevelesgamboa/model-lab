// Run the real model studies, compare the extended shader to the unmodified app
// renderer, and exercise free movement, the optional fold and cancellation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { buildOriginStudy, createOriginServer } from "./serve-dream-origin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  output = await buildOriginStudy(root),
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const preserved = [
  "assets/js/models/cortical-dream-dome.js",
  "assets/js/render/dome-graphics.js",
  "assets/js/render/cortical-waves.glsl",
  "assets/js/shaders/cortical-dome.vert",
  "assets/js/shaders/cortical-dome.frag",
  "assets/js/shaders/cortical-dome-mapping.glsl",
];
const before = Object.fromEntries(
  await Promise.all(
    preserved.map(async (f) => [f, hash(await readFile(path.join(root, f)))]),
  ),
);
const server = await createOriginServer(root, output);
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
const page = await browser.newPage({ viewport: { width: 1220, height: 1100 } }),
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const report = {
  status: "running",
  started: new Date().toISOString(),
  identity: [],
  studies: [],
  errors,
};
try {
  await page.exposeFunction("saveOriginStudy", async (id, stage, base64) => {
    assert.ok(["demo", "photo-1", "photo-2", "photo-3"].includes(id));
    assert.ok(["light", "deep"].includes(stage));
    const dir = path.join(output, "studies", id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, stage + ".png"),
      Buffer.from(base64, "base64"),
    );
  });
  await page.goto(base + "/origin/");
  await page.waitForFunction(() => window.experimentReady);
  await page.evaluate(() => {
    window.experiment.automation = true;
  });
  for (const id of ["demo", "photo-3", "photo-1", "photo-2"]) {
    console.log("Original renderer and stronger model studies:", id);
    if (id !== "demo")
      await page.evaluate((id) => window.experiment.source(id), id);
    const identity = await page.evaluate(async (id) => {
      const e = window.experiment,
        { createOriginRenderer } =
          await import("/origin/dream-origin-renderer.mjs"),
        { OriginSpace } = await import("/origin/dream-origin-space.mjs");
      const canvas = document.createElement("canvas");
      canvas.width = 960;
      canvas.height = 720;
      const reference = await createOriginRenderer(canvas, { extended: false });
      let image = null;
      if (id !== "demo") {
        image = new Image();
        image.src = `/origin/source-${id}.png`;
        await image.decode();
      }
      const seed = await reference.source(image, { features: false });
      reference.model.depthMap = e.renderer.model.depthMap;
      reference.model.featureMap = e.renderer.model.featureMap;
      reference.model.uploadGeometry();
      const checks = [];
      for (let waveMode = 0; waveMode < 4; waveMode++)
        for (const yaw of [0, 0.7]) {
          const pose = new OriginSpace();
          pose.yaw = yaw;
          pose.pitch = yaw * 0.2;
          reference.params.waveMode = e.renderer.params.waveMode = waveMode;
          await reference.draw({ space: pose, base: seed, time: 3.25 });
          await e.renderer.draw({ space: pose, base: e.stages[0], time: 3.25 });
          const a = reference.pixels(),
            b = e.renderer.pixels();
          let max = 0,
            total = 0,
            different = 0;
          for (let n = 0; n < a.length; n++) {
            const delta = Math.abs(a[n] - b[n]);
            max = Math.max(max, delta);
            total += delta;
            if (delta) different++;
          }
          checks.push({
            waveMode,
            yaw,
            maxByte: max,
            meanByte: total / a.length,
            differentBytes: different,
          });
        }
      e.renderer.params.waveMode = 2;
      reference.dispose();
      e.setDepth(0);
      e.clock = 3.25;
      await e.draw();
      return {
        id,
        checks,
        depth: e.renderer.model.depthMap.kind,
        feature: e.renderer.model.featureMap.kind,
      };
    }, id);
    for (const check of identity.checks)
      assert.equal(check.maxByte, 0, JSON.stringify({ id, ...check }));
    report.identity.push(identity);
    // Always regenerate when requested; otherwise use the validated local cache.
    if (
      process.argv.includes("--regenerate") ||
      (await page.evaluate(() => window.experiment.stages.length < 3))
    )
      await page.evaluate(() => window.experiment.generateStudies());
    const study = await page.evaluate(async (id) => {
      const e = window.experiment,
        canvases = e.stages.map((im) => {
          const c = document.createElement("canvas");
          c.width = 1024;
          c.height = 512;
          c.getContext("2d").drawImage(im, 0, 0, 1024, 512);
          return c;
        });
      const data = canvases.map(
          (c) => c.getContext("2d").getImageData(0, 0, 1024, 512).data,
        ),
        changes = [];
      for (let stage = 1; stage <= 2; stage++) {
        let sum = 0,
          changed = 0;
        for (let n = 0; n < data[0].length; n++)
          if (n % 4 !== 3) {
            const delta = Math.abs(data[stage][n] - data[0][n]);
            sum += delta;
            if (delta > 12) changed++;
          }
        changes.push({
          stage,
          meanByte: sum / (1024 * 512 * 3),
          fractionOver12: changed / (1024 * 512 * 3),
        });
        await window.saveOriginStudy(
          id,
          stage === 1 ? "light" : "deep",
          canvases[stage].toDataURL("image/png").split(",")[1],
        );
      }
      await e.comparisons();
      return {
        id,
        version: "origin-study-v1",
        fingerprint: e.fingerprint,
        metrics: e.metrics,
        changes,
        params: { ...e.renderer.params },
      };
    }, id);
    assert.ok(
      study.changes[1].meanByte > study.changes[0].meanByte * 1.3,
      JSON.stringify(study.changes),
    );
    assert.ok(study.changes[1].meanByte > 5);
    for (const stage of study.metrics)
      for (const pass of stage.passes) assert.equal(pass.retainedTensors, 0);
    await writeFile(
      path.join(output, "studies", id, "report.json"),
      JSON.stringify(study, null, 2) + "\n",
    );
    report.studies.push(study);
    for (let depth = 0; depth < 3; depth++) {
      await page.evaluate(async (depth) => {
        const e = window.experiment;
        e.setDepth(depth);
        e.space.enabled = false;
        e.clock = 3.25;
        await e.draw();
      }, depth);
      await page.locator("#view").screenshot({
        path: path.join(
          output,
          `${id}-${["original", "light", "deep"][depth]}.png`,
        ),
      });
    }
    await page
      .locator(".references")
      .screenshot({ path: path.join(output, id + "-comparison.png") });
    console.log(id, study.changes);
  }
  await page.evaluate(() => window.experiment.source("photo-3"));
  report.exploration = await page.evaluate(async () => {
    const e = window.experiment;
    e.setDepth(1);
    e.space.enabled = true;
    e.space.yaw = 0.23;
    e.clock = 4;
    for (let i = 0; i < 240; i++) e.advance(0.1, 1, 1);
    const position = [...e.space.position],
      yaw = e.space.yaw;
    await e.draw();
    if (e.renderer.gl.getError()) throw new Error("Exploration GL error");
    if (Math.hypot(...position) < 50)
      throw new Error("Movement was restricted");
    return { position, yaw, parallax: e.space.parallax };
  });
  assert.equal(report.exploration.yaw, 0.23);
  await page
    .locator("#view")
    .screenshot({ path: path.join(output, "free-exploration.png") });
  await page.evaluate(async () => {
    const e = window.experiment;
    e.home();
    e.space.enabled = true;
    e.space.position = [0, -9];
    await e.draw();
  });
  await page
    .locator("#view")
    .screenshot({ path: path.join(output, "optional-fold.png") });
  report.fold = await page.evaluate(async () => {
    const e = window.experiment,
      start = [...e.space.position],
      yaw = e.space.yaw;
    const entered = await e.enterFold();
    for (let i = 0; i < 18; i++) e.advance(0.1);
    await e.draw();
    return {
      entered,
      start,
      end: [...e.space.position],
      yaw,
      endYaw: e.space.yaw,
      frontier: e.space.frontier,
    };
  });
  assert.equal(report.fold.entered, true);
  assert.deepEqual(report.fold.start, report.fold.end);
  assert.equal(report.fold.yaw, report.fold.endYaw);
  assert.equal(report.fold.frontier, 1);
  // Continue naturally through the cached Deep study, then a newly generated
  // frontier. Rendering and looking remain available during the worker job.
  report.liveFold = await page.evaluate(async () => {
    const e = window.experiment;
    e.space.position = [...e.space.portal];
    await e.enterFold();
    for (let i = 0; i < 15; i++) e.advance(0.1);
    e.space.position = [...e.space.portal];
    const start = [...e.space.position],
      runs = e.generationRuns;
    const ready = e.enterFold();
    e.advance(0.1, 1, 1);
    await e.draw();
    const held = [...e.space.position];
    const entered = await ready;
    for (let i = 0; i < 15; i++) e.advance(0.1);
    await e.draw();
    return {
      entered,
      start,
      held,
      end: [...e.space.position],
      frontier: e.space.frontier,
      newRuns: e.generationRuns - runs,
      glError: e.renderer.gl.getError(),
    };
  });
  assert.equal(report.liveFold.entered, true);
  assert.deepEqual(report.liveFold.held, report.liveFold.start);
  assert.deepEqual(report.liveFold.end, report.liveFold.start);
  assert.equal(report.liveFold.frontier, 3);
  assert.equal(report.liveFold.newRuns, 1);
  assert.equal(report.liveFold.glError, 0);
  await page
    .locator("#view")
    .screenshot({ path: path.join(output, "new-frontier.png") });
  // Start a real uncached deeper generation, then cancel it by returning home.
  await page.evaluate(async () => {
    const e = window.experiment;
    e.space.frontier = 2;
    e.space.position = [...e.space.portal];
    void e.enterFold();
    await new Promise((r) => setTimeout(r, 20));
    e.home();
  });
  await page.waitForTimeout(700);
  report.cancel = await page.evaluate(() => ({
    position: window.experiment.space.position,
    depth: window.experiment.depth,
    warp: window.experiment.warp,
  }));
  assert.deepEqual(report.cancel, { position: [0, 0], depth: 0, warp: null });
  // Every treatment works with the same original mesh and wave modes.
  report.settings = await page.evaluate(async () => {
    const e = window.experiment;
    e.space.enabled = true;
    e.setDepth(2);
    let combinations = 0;
    for (let waveMode = 0; waveMode < 4; waveMode++)
      for (const fullHex of [false, true])
        for (const floor of [0, 0.72, 1])
          for (const negative of [0, 0.55, 1]) {
            e.renderer.params.waveMode = waveMode;
            Object.assign(e.renderer.settings, { fullHex, floor, negative });
            await e.draw();
            if (e.renderer.gl.getError()) throw new Error("Settings GL error");
            combinations++;
          }
    Object.assign(e.renderer.settings, {
      fullHex: false,
      floor: 0.72,
      negative: 0.55,
    });
    e.renderer.params.waveMode = 2;
    return { combinations, glyphs: e.renderer.glyphs };
  });
  assert.equal(new Set(report.settings.glyphs.trim()).size, 16);
  report.performance = await page.evaluate(async () => {
    const e = window.experiment,
      gl = e.renderer.gl,
      ext = gl.getExtension("EXT_disjoint_timer_query_webgl2"),
      debug = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = debug
      ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    if (!ext) return { gpu, gpuTimerSupported: false };
    const samples = [];
    for (let n = 0; n < 24; n++) {
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      await e.draw();
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
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT) && n > 3)
        samples.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
    samples.sort((a, b) => a - b);
    return {
      gpu,
      width: 960,
      height: 720,
      gpuTimerSupported: true,
      samples: samples.length,
      medianMs: samples[Math.floor(samples.length * 0.5)],
      p95Ms: samples[Math.floor(samples.length * 0.95)],
    };
  });
  await page.exposeFunction("saveOriginVideo", async (base64) =>
    writeFile(
      path.join(output, "open-dome-walkthrough.webm"),
      Buffer.from(base64, "base64"),
    ),
  );
  report.recording = await page.evaluate(async () => {
    const e = window.experiment,
      canvas = document.getElementById("view");
    e.home();
    e.space.enabled = true;
    e.paused = false;
    e.clock = 3.25;
    const stream = canvas.captureStream(30),
      chunks = [],
      recorder = new MediaRecorder(stream, {
        mimeType: "video/webm;codecs=vp9",
        videoBitsPerSecond: 5000000,
      });
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    const stopped = new Promise((r) => {
      recorder.onstop = r;
    });
    recorder.start();
    let entered = false;
    await new Promise((resolve, reject) => {
      const start = performance.now();
      let previous = start;
      async function frame(now) {
        try {
          const dt = Math.max(0, Math.min(0.1, (now - previous) / 1000));
          previous = now;
          e.advance(dt, 1, 0);
          if (e.space.nearPortal && !entered) {
            entered = true;
            void e.enterFold();
          }
          await e.draw();
          if (now - start < 8000) requestAnimationFrame(frame);
          else resolve();
        } catch (error) {
          reject(error);
        }
      }
      requestAnimationFrame(frame);
    });
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: recorder.mimeType });
    const base64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.readAsDataURL(blob);
    });
    await window.saveOriginVideo(base64);
    return {
      file: "open-dome-walkthrough.webm",
      seconds: 8,
      bytes: blob.size,
      frontiers: e.space.frontier,
    };
  });
  // Exercise actual controls and compare hold, including a mobile viewport.
  await page.evaluate(() => {
    window.experiment.automation = false;
    window.experiment.home();
  });
  await page.check("#explore");
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(350);
  await page.keyboard.up("KeyD");
  assert.ok(
    await page.evaluate(() => window.experiment.space.position[0] > 0.2),
  );
  await page.locator("[data-depth='2']").click();
  await page.locator("#view").focus();
  await page.keyboard.down("KeyB");
  await page.waitForTimeout(80);
  await page.keyboard.up("KeyB");
  await page.click("#home");
  assert.equal(await page.evaluate(() => window.experiment.depth), 0);
  // A custom photo initializes the original model and can generate new studies.
  await page.setInputFiles("#upload", path.join(output, "source-photo-3.png"));
  await page.waitForFunction(
    () => window.experiment.sourceId === "custom" && !window.experiment.loading,
  );
  assert.equal(await page.evaluate(() => window.experiment.stages.length), 1);
  await page.selectOption("#source", "photo-2");
  await page.waitForFunction(
    () =>
      window.experiment.sourceId === "photo-2" && !window.experiment.loading,
  );
  assert.equal(await page.evaluate(() => window.experiment.stages.length), 3);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  report.controls =
    "Source selection, depth changes, keyboard sidestep, original comparison hold, home and 390px viewport passed.";
  report.preserved = before;
  for (const [file, sha] of Object.entries(before))
    assert.equal(hash(await readFile(path.join(root, file))), sha);
  assert.deepEqual(errors, []);
  report.status = "complete";
  report.finished = new Date().toISOString();
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await writeFile(
    path.join(root, "verification/dream-drift-origin.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        status: report.status,
        identityViews: report.identity.reduce((n, r) => n + r.checks.length, 0),
        settings: report.settings.combinations,
        studies: report.studies.map((s) => ({ id: s.id, changes: s.changes })),
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
