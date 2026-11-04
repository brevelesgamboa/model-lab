import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { buildOpenDrift, createOpenDriftServer } from "./serve-dream-open.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  output = await buildOpenDrift(root),
  server = await createOpenDriftServer(root, output);
const protectedFiles = [
    "assets/js/models/cortical-dream-dome.js",
    "assets/js/render/cortical-waves.glsl",
    "tools/dream-origin-shaders.mjs",
    "tools/dream-world-shaders.mjs",
  ],
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const before = Object.fromEntries(
  await Promise.all(
    protectedFiles.map(async (f) => [
      f,
      hash(await readFile(path.join(root, f))),
    ]),
  ),
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=vulkan",
      "--enable-features=Vulkan",
      "--enable-gpu",
    ],
  }),
  page = await browser.newPage({ viewport: { width: 1220, height: 1100 } }),
  errors = [];
page.on("pageerror", (e) => {
  errors.push(e.message);
  console.log("Browser error", e.message);
});
page.on("console", (message) => {
  if (message.type() === "error")
    console.log("Browser console:", message.text().slice(0, 1600));
});
const report = { started: new Date().toISOString(), status: "running", errors };
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/drift/`);
  await page.waitForFunction(() => window.openDriftReady, null, {
    timeout: 60000,
  });
  await page.evaluate(() => {
    window.openDrift.automation = true;
  });
  report.initial = await page.evaluate(async () => {
    const e = window.openDrift;
    await e.draw();
    return {
      render: e.lastRender,
      params: { ...e.renderer.params },
      landscapes: e.content.landscapes.length,
      options: { autoWaves: e.field.autoWaves, strength: e.field.strength },
    };
  });
  assert.equal(report.initial.landscapes, 3);
  assert.equal(report.initial.render.glError, 0);
  await page
    .locator("#view")
    .screenshot({ path: path.join(output, "initial.png") });
  console.log("Initial shader and landscape loading passed");
  if (process.argv.includes("--smoke")) {
    console.log(JSON.stringify(report.initial));
  } else {
    console.log("Comparing the approved renderer and full hex");
    report.parity = await page.evaluate(async () => {
      const e = window.openDrift,
        { createOriginRenderer } =
          await import("/drift/dream-origin-renderer.mjs"),
        { openAppearance } = await import("/drift/dream-open-field.mjs");
      const c = document.createElement("canvas");
      c.width = 960;
      c.height = 720;
      const reference = await createOriginRenderer(c);
      const image = new Image();
      image.src = "/origin/source-photo-3.png";
      await image.decode();
      await reference.source(image, { features: false });
      reference.model.depthMap = e.renderer.model.depthMap;
      reference.model.featureMap = e.renderer.model.featureMap;
      reference.model.uploadGeometry();
      const settings = { ...e.renderer.settings },
        params = { ...e.renderer.params },
        checks = [];
      for (const full of [false, true])
        for (let mode = 0; mode < 4; mode++) {
          Object.assign(reference.params, params, { waveMode: mode });
          e.renderer.params.waveMode = mode;
          reference.settings.fullHex = full;
          reference.settings.portal = false;
          e.renderer.settings.fullHex = false;
          e.renderer.settings.portal = false;
          const pose = {
              enabled: true,
              position: [0, 0],
              yaw: 0.3,
              pitch: 0.1,
              parallax: [0, 0, 0],
            },
            base = e.content.stages[full ? 2 : 0];
          await reference.draw({
            space: pose,
            base,
            time: 3.25,
            depth: full ? 2 : 0,
          });
          await e.renderer.draw({
            space: pose,
            base,
            time: 3.25,
            appearance: openAppearance(full ? 3 : 0),
          });
          const a = reference.pixels(),
            b = e.renderer.pixels();
          let max = 0,
            total = 0;
          for (let n = 0; n < a.length; n++) {
            const d = Math.abs(a[n] - b[n]);
            max = Math.max(max, d);
            total += d;
          }
          checks.push({
            fullHex: full,
            mode,
            maxByte: max,
            meanByte: total / a.length,
          });
        }
      Object.assign(e.renderer.settings, settings);
      Object.assign(e.renderer.params, params);
      reference.dispose();
      return checks;
    });
    for (const check of report.parity) {
      // The extra dynamic wave branch can change GPU rounding by a byte.
      assert.ok(
        check.maxByte <= 2 && check.meanByte < 0.001,
        JSON.stringify(check),
      );
    }
    console.log("Testing free movement, depth and wave toggles");
    report.drift = await page.evaluate(async () => {
      const e = window.openDrift,
        baseline = { ...e.renderer.params };
      e.field.autoDepth = true;
      for (let n = 0; n < 2900; n++) e.advance(0.1);
      await e.draw();
      const automatic = { ...e.lastEffective },
        depth = e.field.depth;
      e.field.autoWaves = false;
      for (let n = 0; n < 250; n++) e.advance(0.1);
      await e.draw();
      const manual = { ...e.lastEffective },
        position = [...e.space.position];
      e.advance(0.1, 1, 1);
      return {
        baseline,
        automatic,
        manual,
        depth,
        hex: document.getElementById("readout").textContent,
        moved: Math.hypot(
          e.space.position[0] - position[0],
          e.space.position[1] - position[1],
        ),
        baseUnchanged:
          JSON.stringify(baseline) === JSON.stringify(e.renderer.params),
      };
    });
    assert.equal(report.drift.depth, 3);
    assert.equal(report.drift.baseUnchanged, true);
    assert.deepEqual(report.drift.manual, report.drift.baseline);
    assert.notDeepEqual(report.drift.automatic, report.drift.baseline);
    assert.ok(report.drift.moved > 0.2);
    assert.match(report.drift.hex, /100% colored hex/);
    // Generate actual new local-model output from each supplied photo.
    report.sources = [];
    for (const id of ["photo-1", "photo-2", "photo-3"]) {
      console.log("Generating a procedural panorama for", id);
      await page.evaluate((id) => window.openDrift.source(id), id);
      const result = await page.evaluate(async () => {
        const e = window.openDrift;
        e.field.depth = 2.2;
        e.field.autoDepth = false;
        const descriptor = {
          ...e.field.descriptor([65, -97], false),
          landscape: -1,
        };
        const result = await e.content.prepare(
          descriptor,
          new AbortController().signal,
        );
        e.image = result.image;
        e.currentKey = descriptor.key;
        e.clock = 4.25;
        await e.draw();
        return {
          id: e.sourceId,
          width: result.image.width,
          height: result.image.height,
          restored: result.restored,
          metrics: e.content.metrics,
          glError: e.lastRender.glError,
        };
      });
      assert.equal(result.glError, 0);
      assert.ok(result.metrics.length > 0);
      assert.equal(result.metrics.at(-1).retainedTensors, 0);
      report.sources.push(result);
      await page
        .locator("#view")
        .screenshot({ path: path.join(output, `${id}-drift.png`) });
    }
    report.landscapes = [];
    for (let index = 0; index < 3; index++) {
      console.log("Testing landscape study", index);
      const result = await page.evaluate(async (index) => {
        const e = window.openDrift;
        const descriptor = {
          ...e.field.descriptor([index * 93, -57]),
          key: `landscape-check:${index}`,
          landscape: index,
          stage: 2,
        };
        const prepared = await e.content.prepare(
          descriptor,
          new AbortController().signal,
        );
        e.image = prepared.image;
        e.blend = null;
        e.currentKey = descriptor.key;
        e.field.depth = 1.6;
        e.field.age = 64;
        e.field.autoWaves = true;
        e.field.waveAmount = 0.65;
        e.field.wavePhase = 40;
        e.space.home();
        e.space.enabled = true;
        await e.draw();
        return {
          index,
          width: prepared.image.width,
          height: prepared.image.height,
          metrics: e.content.metrics.at(-1),
          glError: e.lastRender.glError,
        };
      }, index);
      assert.equal(result.glError, 0);
      assert.equal(result.metrics.retainedTensors, 0);
      report.landscapes.push(result);
      await page
        .locator("#view")
        .screenshot({ path: path.join(output, `landscape-${index}.png`) });
      await page.evaluate(async () => {
        const e = window.openDrift;
        e.field.depth = 3;
        await e.draw();
      });
      await page
        .locator("#view")
        .screenshot({ path: path.join(output, `landscape-${index}-hex.png`) });
    }
    console.log("Testing temporary arches and unrestricted movement");
    report.encounters = [];
    for (let type = 0; type < 4; type++) {
      const result = await page.evaluate(async (type) => {
        const e = window.openDrift;
        e.field.effect = null;
        e.encounter({ id: `test:${type}`, type });
        const duration = e.field.effect.duration,
          start = [...e.space.position];
        for (let n = 0; n < 50; n++) e.advance(0.1, 1, 0.2);
        await e.draw();
        const amount = e.field.effectAmount,
          next = e.field.descriptor(e.space.position),
          moved = Math.hypot(
            e.space.position[0] - start[0],
            e.space.position[1] - start[1],
          );
        return {
          type,
          duration,
          amount,
          moved,
          key: next.key,
          glError: e.lastRender.glError,
        };
      }, type);
      assert.equal(result.glError, 0);
      assert.ok(result.amount > 0.9);
      assert.ok(result.moved > 10);
      assert.ok(result.duration >= 22 && result.duration <= 34);
      report.encounters.push(result);
      await page
        .locator("#view")
        .screenshot({ path: path.join(output, `encounter-${type}.png`) });
      assert.equal(
        await page.evaluate(() => {
          const e = window.openDrift;
          for (let n = 0; n < 350; n++) e.advance(0.1);
          return e.field.effect;
        }),
        null,
      );
    }
    report.walkThrough = await page.evaluate(() => {
      const e = window.openDrift;
      e.home();
      const arch = e.field
        .arches(e.space.position)
        .find((a) => a.id === "first");
      e.space.position = arch.position.map(
        (v, i) => v - [Math.sin(arch.yaw), -Math.cos(arch.yaw)][i] * 0.1,
      );
      e.space.yaw = arch.yaw;
      e.advance(0.1, 1);
      return { type: e.field.effect?.type, expected: arch.type };
    });
    assert.equal(report.walkThrough.type, report.walkThrough.expected);
    // Exercise a failed generation while the displayed scene and movement continue.
    report.failure = await page.evaluate(async () => {
      const e = window.openDrift;
      while (e.content.active) await new Promise((r) => setTimeout(r, 10));
      const original = e.content.prepare.bind(e.content),
        image = e.image;
      e.content.prepare = async () => {
        throw new Error("Controlled generation failure");
      };
      e.content.request({
        ...e.field.descriptor([0, 0]),
        key: "failure-check",
      });
      while (e.content.active) await new Promise((r) => setTimeout(r, 10));
      const error = e.content.error,
        before = [...e.space.position];
      e.advance(0.1, 0, 1);
      await e.draw();
      e.content.prepare = original;
      return {
        error,
        imageRetained: e.image === image,
        moved: Math.hypot(
          e.space.position[0] - before[0],
          e.space.position[1] - before[1],
        ),
      };
    });
    assert.match(report.failure.error, /Controlled/);
    assert.equal(report.failure.imageRetained, true);
    assert.ok(report.failure.moved > 0.2);
    console.log("Testing bounded background cache");
    report.cache = await page.evaluate(async () => {
      const e = window.openDrift;
      e.field.effect = null;
      while (e.content.active) await new Promise((r) => setTimeout(r, 10));
      for (let n = 0; n < 14; n++) {
        const descriptor = {
          ...e.field.descriptor([n * 53, -n * 71], false),
          key: `cache-check:${n}`,
          stage: 0,
          landscape: -1,
        };
        e.content.request(descriptor);
        while (e.content.active) await new Promise((r) => setTimeout(r, 10));
      }
      return {
        images: e.content.cache.size,
        blobs: e.content.store.memory.size,
        pending: e.content.pending,
        active: e.content.active,
        error: e.content.error,
      };
    });
    assert.ok(report.cache.images <= 8);
    assert.ok(report.cache.blobs <= 6);
    assert.equal(report.cache.active, null);
    assert.equal(report.cache.error, "");
    await page.getByText("Your wave settings", { exact: true }).click();
    await page.evaluate(() => {
      for (const [id, value] of Object.entries({
        gain: 0.19,
        frequency: 10.4,
        strength: 0.27,
      })) {
        const input = document.getElementById(id);
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    // Earlier render probes set field state directly. Synchronize through the
    // real checkbox before verifying the saved preference.
    await page.check("#auto-waves");
    await page.uncheck("#auto-waves");
    await page.uncheck("#auto-depth");
    await page.uncheck("#landscapes");
    await page.click("#save-look");
    await page.reload();
    await page.waitForFunction(() => window.openDriftReady);
    report.saved = await page.evaluate(() => {
      const e = window.openDrift;
      e.automation = true;
      return {
        gain: e.renderer.params.gain,
        frequency: e.renderer.params.frequency,
        strength: e.field.strength,
        autoWaves: e.field.autoWaves,
        autoDepth: e.field.autoDepth,
        landscapes: e.landscapes,
      };
    });
    assert.deepEqual(report.saved, {
      gain: 0.19,
      frequency: 10.4,
      strength: 0.27,
      autoWaves: false,
      autoDepth: false,
      landscapes: false,
    });
    // A real custom upload must not silently mix the marmot-only scene studies.
    await page.setInputFiles(
      "#upload",
      path.join(root, "test-results/dream-drift-origin/source-photo-1.png"),
    );
    await page.waitForFunction(
      () => window.openDrift.sourceId === "custom" && !window.openDrift.loading,
    );
    assert.equal(await page.evaluate(() => window.openDrift.landscapes), false);
    report.customUpload = true;
    await page.evaluate(() => {
      window.openDrift.automation = false;
    });
    await page.locator("#view").focus();
    await page.keyboard.down("KeyD");
    await page.waitForTimeout(350);
    await page.keyboard.up("KeyD");
    assert.ok(
      await page.evaluate(() => window.openDrift.space.position[0] > 0.2),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    report.controls =
      "Free keyboard movement, automatic-wave toggle, strength, saved base settings, independent depth/hex, custom image and 390px layout passed.";
    report.status = "complete";
    assert.deepEqual(errors, []);
    for (const [f, sha] of Object.entries(before))
      assert.equal(hash(await readFile(path.join(root, f))), sha);
    report.preserved = before;
    await writeFile(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    await writeFile(
      path.join(root, "verification/dream-drift-open.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
      JSON.stringify(
        {
          status: report.status,
          parity: report.parity.length,
          sources: report.sources.length,
          landscapes: report.landscapes.length,
          cache: report.cache,
          saved: report.saved,
          errors,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
