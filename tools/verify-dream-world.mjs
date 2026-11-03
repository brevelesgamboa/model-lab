// Native-GPU exploration, original-look parity, persistent revisits and presets.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  buildDreamWorld,
  createDreamWorldServer,
} from "./serve-dream-world.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  output = await buildDreamWorld(root),
  server = await createDreamWorldServer(root, output);
const protectedFiles = [
  "assets/js/models/cortical-dream-dome.js",
  "assets/js/render/dome-graphics.js",
  "assets/js/render/cortical-waves.glsl",
  "assets/js/shaders/cortical-dome.vert",
  "assets/js/shaders/cortical-dome.frag",
  "tools/dream-origin-shaders.mjs",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  before = Object.fromEntries(
    await Promise.all(
      protectedFiles.map(async (file) => [
        file,
        hash(await readFile(path.join(root, file))),
      ]),
    ),
  );
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
  }),
  page = await browser.newPage({ viewport: { width: 1250, height: 1150 } }),
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const report = {
  status: "running",
  started: new Date().toISOString(),
  reference: [],
  visits: [],
  errors,
};
async function visit(target, { near = false } = {}) {
  console.log("Exploring", target);
  const result = await page.evaluate(
    async ({ target, near }) => {
      const e = window.worldDemo,
        { imageFingerprint } = await import("/world/dream-world-content.mjs"),
        from = e.world.current;
      const g = e.world
        .gates(e.space.position)
        .find((g) => g.target === target);
      if (!g) throw new Error("No connected fold");
      if (near) {
        e.space.position = g.position.map((v, i) => v - g.direction[i]);
        e.world.discoverAt(e.space.position);
      }
      e.faceGate(target);
      for (let i = 0; i < 400 && !e.warp; i++) {
        e.advance(0.1, 1);
        if (i % 20 === 0) await e.draw();
      }
      if (!e.warp) throw new Error("Walking did not enter the fold");
      await e.travel;
      if (e.warp?.phase !== "blend") throw new Error("Fold failed to prepare");
      for (let i = 0; i < 18; i++) {
        e.advance(0.1);
        if (i % 3 === 0) await e.draw();
      }
      if (e.world.current !== target) throw new Error("Wrong arrival");
      e.space.position = [0, 0];
      e.space.yaw = 0;
      e.space.pitch = 0;
      e.clock = 4.25;
      await e.draw();
      e.saveProgress();
      if (e.renderer.gl.getError())
        throw new Error("WebGL error after arrival");
      return {
        from,
        to: target,
        depth: e.world.area.depth,
        image: await imageFingerprint(e.image),
        runs: e.content.runs,
        metadata: e.content.metrics.get(target),
        shortcutOpen: e.world.shortcutOpen,
        visited: [...e.world.visited],
        look: { ...e.renderer.params },
      };
    },
    { target, near },
  );
  await page.locator(".scene").screenshot({
    path: path.join(output, `${target}-${report.visits.length}.png`),
  });
  report.visits.push(result);
  return result;
}
try {
  await page.goto(base + "/world/");
  await page.waitForFunction(() => window.worldReady, null, { timeout: 45000 });
  await page.evaluate(() => {
    window.worldDemo.automation = true;
  });
  report.reference = await page.evaluate(async () => {
    const e = window.worldDemo,
      { createOriginRenderer } =
        await import("/world/dream-origin-renderer.mjs"),
      image = new Image();
    image.src = "/origin/source-photo-3.png";
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 720;
    const reference = await createOriginRenderer(canvas, { extended: false });
    const seed = await reference.source(image, { features: false });
    reference.model.depthMap = e.renderer.model.depthMap;
    reference.model.featureMap = e.renderer.model.featureMap;
    reference.model.uploadGeometry();
    const checks = [];
    for (let waveMode = 0; waveMode < 4; waveMode++)
      for (const yaw of [0, 0.7]) {
        const pose = {
          enabled: false,
          position: [0, 0],
          parallax: [0, 0, 0],
          yaw,
          pitch: yaw * 0.2,
        };
        reference.params.waveMode = e.renderer.params.waveMode = waveMode;
        await reference.draw({ base: seed, space: pose, time: 3.25 });
        await e.renderer.draw({
          base: e.content.stages[0],
          space: pose,
          original: true,
          time: 3.25,
        });
        const a = reference.pixels(),
          b = e.renderer.pixels();
        let max = 0;
        for (let n = 0; n < a.length; n++)
          max = Math.max(max, Math.abs(a[n] - b[n]));
        checks.push({ waveMode, yaw, maxByte: max });
      }
    reference.dispose();
    e.renderer.params.waveMode = 2;
    await e.draw();
    return checks;
  });
  for (const r of report.reference) assert.equal(r.maxByte, 0);
  // The automatic deep treatment must match the approved full-hex material.
  report.fullHexParity = await page.evaluate(async () => {
    const e = window.worldDemo,
      { createOriginRenderer } =
        await import("/world/dream-origin-renderer.mjs"),
      canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 720;
    const reference = await createOriginRenderer(canvas),
      image = new Image();
    image.src = "/origin/source-photo-3.png";
    await image.decode();
    await reference.source(image, { features: false });
    reference.model.depthMap = e.renderer.model.depthMap;
    reference.model.featureMap = e.renderer.model.featureMap;
    reference.model.uploadGeometry();
    reference.settings.fullHex = true;
    const base = e.content.stages[2];
    await reference.draw({ base, depth: 2, time: 4.25 });
    await e.renderer.draw({
      base,
      appearance: { neon: 0.35, hex: 1, corruption: 0.72 },
      time: 4.25,
    });
    const a = reference.pixels(),
      b = e.renderer.pixels();
    let max = 0,
      total = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      max = Math.max(max, d);
      total += d;
    }
    reference.dispose();
    await e.draw();
    return { maxByte: max, meanByte: total / a.length };
  });
  assert.ok(
    report.fullHexParity.maxByte <= 2,
    JSON.stringify(report.fullHexParity),
  );
  assert.ok(report.fullHexParity.meanByte < 0.01);
  const initial = await page.evaluate(async () => {
    const e = window.worldDemo,
      { imageFingerprint } = await import("/world/dream-world-content.mjs");
    await e.draw();
    return {
      image: await imageFingerprint(e.image),
      gates: e.world
        .gates()
        .filter((g) => g.open)
        .map((g) => g.target),
      params: { ...e.renderer.params },
    };
  });
  assert.deepEqual(initial.gates, ["waves", "garden"]);
  await page
    .locator(".scene")
    .screenshot({ path: path.join(output, "clearing.png") });
  const firstImages = new Map([["clearing", initial.image]]);
  for (const target of [
    "waves",
    "terrace",
    "hex",
    "garden",
    "clearing",
    "garden",
    "pocket",
    "hex",
    "terrace",
    "clearing",
  ]) {
    const result = await visit(target);
    if (firstImages.has(target))
      assert.equal(result.image, firstImages.get(target));
    else firstImages.set(target, result.image);
    assert.deepEqual(result.look, initial.params);
  }
  assert.equal(firstImages.size, 6);
  assert.ok(
    report.visits.some((v) => v.from === "terrace" && v.to === "clearing"),
  );
  for (const visit of report.visits)
    if (visit.metadata?.kind === "generated place")
      assert.equal(visit.metadata.retainedTensors, 0);
  await visit("garden", { near: true });
  await visit("hex", { near: true });
  assert.match(
    await page.locator("#readout").textContent(),
    /colored hex 100%/,
  );
  const hexImage = firstImages.get("hex");
  // Persistence across a real page reload, not merely an in-memory visit.
  await page.reload();
  await page.waitForFunction(() => window.worldReady);
  await page.evaluate(() => {
    window.worldDemo.automation = true;
  });
  report.reload = await page.evaluate(async () => {
    const e = window.worldDemo,
      { imageFingerprint } = await import("/world/dream-world-content.mjs");
    return {
      area: e.world.current,
      visited: [...e.world.visited],
      image: await imageFingerprint(e.image),
      runs: e.content.runs,
      restored: e.content.restored,
    };
  });
  assert.equal(report.reload.area, "hex");
  assert.equal(report.reload.image, hexImage);
  assert.equal(report.reload.runs, 0);
  assert.ok(report.reload.restored >= 1);
  assert.equal(report.reload.visited.length, 6);
  // A cancelled late result must not replace the current place.
  report.cancellation = await page.evaluate(async () => {
    const e = window.worldDemo,
      saved = await e.requestPlace("garden", true);
    e.home();
    await new Promise((r) => setTimeout(r, 0));
    const original = e.content.prepare.bind(e.content);
    e.content.images.delete("garden");
    let complete;
    e.content.prepare = (id, options) =>
      id === "garden"
        ? new Promise((resolve) => {
            complete = resolve;
          })
        : original(id, options);
    const gate = e.world.gates().find((g) => g.target === "garden");
    e.space.position = gate.position.map((v, i) => v - gate.direction[i]);
    const entered = e.enterGate("garden");
    const deadline = performance.now() + 5000;
    while (!complete && performance.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    if (!complete) throw new Error("Controlled place load did not start");
    const held = [...e.space.position];
    e.advance(0.1, 1, 1);
    const stopped = e.space.position.every((v, i) => v === held[i]);
    await e.draw();
    e.home();
    complete(saved);
    await entered;
    await new Promise((r) => setTimeout(r, 0));
    e.content.prepare = original;
    e.content.images.set("garden", saved);
    await e.draw();
    return {
      stopped,
      area: e.world.current,
      position: e.space.position,
      warp: e.warp,
    };
  });
  assert.equal(report.cancellation.stopped, true);
  assert.equal(report.cancellation.area, "clearing");
  assert.deepEqual(report.cancellation.position, [0, 0]);
  assert.equal(report.cancellation.warp, null);
  // User look overrides never change on area transitions, and survive reloads.
  console.log("Checking saved looks");
  await page.getByText("Floor and colored hex", { exact: true }).click();
  await page.evaluate(() => {
    for (const [id, value] of Object.entries({
      gain: 0.47,
      frequency: 11.3,
      eccentricity: 0.08,
      waveMode: 3,
      floor: 0.62,
      negative: 0.71,
    })) {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await page.check("#hex");
  await page.fill("#look-name", "Saved neon test");
  await page.click("#save-look");
  await page.evaluate(() => {
    const input = document.getElementById("gain");
    input.value = 0.12;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.click("#load-look");
  assert.equal(
    await page.evaluate(() => window.worldDemo.renderer.params.gain),
    0.47,
  );
  await page.reload();
  await page.waitForFunction(() => window.worldReady);
  report.preset = await page.evaluate(() => {
    const e = window.worldDemo;
    e.automation = true;
    return {
      gain: e.renderer.params.gain,
      frequency: e.renderer.params.frequency,
      waveMode: e.renderer.params.waveMode,
      floor: e.renderer.settings.floor,
      negative: e.renderer.settings.negative,
      fullHex: e.renderer.settings.fullHex,
    };
  });
  assert.deepEqual(report.preset, {
    gain: 0.47,
    frequency: 11.3,
    waveMode: 3,
    floor: 0.62,
    negative: 0.71,
    fullHex: true,
  });
  await page.click("#reset-look");
  await page.evaluate(() => {
    window.worldDemo.home();
  });
  // Every supplied photo uses its own persistent place cache.
  report.sources = [];
  for (const id of ["photo-1", "photo-2"]) {
    console.log("Checking source", id);
    await page.evaluate((id) => window.worldDemo.source(id), id);
    await page.evaluate(() => window.worldDemo.requestPlace("garden", true));
    const result = await page.evaluate(async () => {
      const e = window.worldDemo,
        { imageFingerprint } = await import("/world/dream-world-content.mjs");
      return {
        source: e.sourceId,
        key: e.key,
        garden: await imageFingerprint(e.content.images.get("garden")),
        metrics: e.content.metrics.get("garden"),
      };
    });
    report.sources.push(result);
    assert.equal(result.metrics.retainedTensors, 0);
  }
  await page.evaluate(() => window.worldDemo.source("photo-3"));
  // Render cost after prefetch has settled; this includes four gates and a landmark.
  for (const id of ["garden", "terrace", "pocket", "hex"])
    await page.evaluate((id) => window.worldDemo.requestPlace(id, true), id);
  console.log("Measuring GPU render cost");
  report.performance = await page.evaluate(async () => {
    const e = window.worldDemo;
    e.home();
    const gl = e.renderer.gl,
      ext = gl.getExtension("EXT_disjoint_timer_query_webgl2"),
      debug = gl.getExtension("WEBGL_debug_renderer_info"),
      gpu = debug
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
      const until = performance.now() + 4000;
      while (
        !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) &&
        performance.now() < until
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
      samples: samples.length,
      medianMs: samples[Math.floor(samples.length * 0.5)],
      p95Ms: samples[Math.floor(samples.length * 0.95)],
      textures: 15,
      images: e.content.images.size,
    };
  });
  assert.ok(report.performance.images <= 6);
  await page.exposeFunction("saveWorldVideo", async (base64) =>
    writeFile(
      path.join(output, "branching-world.webm"),
      Buffer.from(base64, "base64"),
    ),
  );
  console.log("Recording continuous walkthrough");
  report.recording = await page.evaluate(async () => {
    const e = window.worldDemo,
      canvas = document.getElementById("view");
    e.home();
    e.clock = 3.25;
    e.space.speed = 3.5;
    let heading = "",
      entered = [];
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
    await new Promise((resolve, reject) => {
      const start = performance.now();
      let previous = start;
      async function frame(now) {
        try {
          const dt = Math.max(0, Math.min(0.1, (now - previous) / 1000));
          previous = now;
          if (e.world.current !== heading) {
            heading = e.world.current;
            entered.push(heading);
            const target = {
              clearing: "waves",
              waves: "terrace",
              terrace: "hex",
            }[heading];
            if (target) e.faceGate(target);
          }
          e.advance(dt, e.world.current === "hex" ? 0 : 1);
          await e.draw();
          if (now - start < 22000) requestAnimationFrame(frame);
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
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(",")[1]);
      r.readAsDataURL(blob);
    });
    await window.saveWorldVideo(base64);
    e.space.speed = 2.5;
    return {
      file: "branching-world.webm",
      seconds: 22,
      walkSpeed: 3.5,
      places: entered,
      bytes: blob.size,
    };
  });
  assert.ok(report.recording.places.includes("hex"));
  // Check actual keyboard controls and mobile layout with the live page loop.
  await page.evaluate(() => {
    const e = window.worldDemo;
    e.home();
    const gate = e.world.gates().find((g) => g.target === "waves");
    e.space.position = gate.position.map((v, i) => v - gate.direction[i]);
  });
  await page.locator("#view").focus();
  await page.keyboard.press("KeyE");
  await page.evaluate(async () => {
    const e = window.worldDemo;
    await e.travel;
    for (let i = 0; i < 18; i++) e.advance(0.1);
    await e.draw();
    if (e.world.current !== "waves") throw new Error("E did not enter fold");
  });
  await page.evaluate(() => {
    window.worldDemo.home();
    window.worldDemo.automation = false;
  });
  await page.locator("#view").focus();
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(350);
  await page.keyboard.up("KeyD");
  assert.ok(
    await page.evaluate(() => window.worldDemo.space.position[0] > 0.2),
  );
  await page.uncheck("#show-map");
  await page.locator("#map-wrap").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#map-wrap").isHidden(), true);
  await page.check("#show-map");
  await page.locator("#map-wrap").waitFor({ state: "visible" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  report.controls =
    "Walk-through folds, E entry, free keyboard movement, map visibility, look controls, save/load presets and 390px layout passed.";
  assert.deepEqual(errors, []);
  for (const [file, sha] of Object.entries(before))
    assert.equal(hash(await readFile(path.join(root, file))), sha);
  report.preserved = before;
  report.status = "complete";
  report.finished = new Date().toISOString();
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await writeFile(
    path.join(root, "verification/dream-drift-world.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        status: report.status,
        visits: report.visits.length,
        fullHexParity: report.fullHexParity,
        reload: report.reload,
        performance: report.performance,
        recording: report.recording,
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
