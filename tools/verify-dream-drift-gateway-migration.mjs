// Compare a preserved Gemini demo with a gallery rebuilt from tracked source.
// node tools/verify-dream-drift-gateway-migration.mjs before.html rebuilt.html
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [before, after] = process.argv.slice(2).map((file) => path.resolve(file));
assert(before && after, "Pass the preserved demo and rebuilt gallery paths.");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const browser = await chromium.launch({
  args: [
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=vulkan",
    "--enable-features=Vulkan",
    "--enable-gpu",
  ],
});
const errors = [];
async function inspect(file) {
  const page = await browser.newPage({
    viewport: { width: 1250, height: 1000 },
  });
  page.on("pageerror", (error) =>
    errors.push({ file: path.basename(file), message: error.message }),
  );
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(() => window.experimentReady);
  const result = await page.evaluate(async () => {
    const e = window.experiment,
      r = e.renderer,
      canvas = document.getElementById("view");
    e.automation = true;
    canvas.width = 320;
    canvas.height = 240;
    const controls = [...document.querySelectorAll("select")].map((s) => ({
      id: s.id,
      value: s.value,
      options: [...s.options].map((o) => ({
        value: o.value,
        label: o.textContent.trim().replace(/\s+/g, " "),
      })),
    }));
    const initialSettings = { ...r.settings },
      frames = [];
    async function frame(key, time) {
      r.draw(time);
      const bytes = r.pixels();
      const digest = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      ]
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
      frames.push([key, digest]);
      if (r.gl.getError() !== r.gl.NO_ERROR)
        throw new Error("WebGL error at " + key);
    }
    for (const scene of e.scenes) {
      await e.selectScene(scene.id);
      for (let archStyle = 0; archStyle < 6; archStyle++)
        for (let animMode = 0; animMode < 5; animMode++)
          for (const animSpeed of [0.5, 1, 1.8])
            for (const [columns, rows] of [
              [240, 80],
              [320, 112],
              [416, 144],
            ]) {
              Object.assign(r.settings, {
                mode: 2,
                geometry: 2,
                archStyle,
                animMode,
                animSpeed,
                columns,
                rows,
              });
              await frame(
                `${scene.id}/arch${archStyle}/anim${animMode}/speed${animSpeed}/cols${columns}`,
                3.25,
              );
            }
      for (const geometry of [0, 1])
        for (const mode of [0, 1, 2])
          for (const time of [0, 8]) {
            Object.assign(r.settings, {
              geometry,
              mode,
              archStyle: 1,
              animMode: 4,
              animSpeed: 1.8,
              columns: 320,
              rows: 112,
            });
            await frame(
              `${scene.id}/geometry${geometry}/mode${mode}/t${time}`,
              time,
            );
          }
      Object.assign(r.settings, {
        geometry: 2,
        mode: 1,
        archStyle: 1,
        animMode: 4,
        animSpeed: 1.8,
        columns: 320,
        rows: 112,
      });
      r.camera.yaw = 0.22;
      r.camera.target = [0.32, 0, 0.1];
      await frame(`${scene.id}/translated`, 8);
    }
    const extension = r.gl.getExtension("WEBGL_debug_renderer_info");
    return {
      controls,
      initialSettings,
      frames,
      renderer: extension
        ? r.gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
        : r.gl.getParameter(r.gl.RENDERER),
    };
  });
  console.log(
    `Compared fixture inputs: ${path.basename(file)} · ${result.frames.length} frames captured`,
  );
  return { page, result };
}

try {
  const old = await inspect(before),
    rebuilt = await inspect(after);
  assert.deepEqual(
    rebuilt.result.controls,
    old.result.controls,
    "Control options/defaults changed during extraction",
  );
  assert.deepEqual(
    rebuilt.result.initialSettings,
    old.result.initialSettings,
    "Renderer defaults changed",
  );
  const mismatches = rebuilt.result.frames.flatMap(([key, pixels], i) => {
    assert.equal(key, old.result.frames[i][0]);
    return pixels === old.result.frames[i][1] ? [] : [key];
  });
  assert.equal(
    mismatches.length,
    0,
    `Pixel differences in ${mismatches.slice(0, 10).join(", ")}`,
  );
  const page = rebuilt.page;
  // Exercise the actual UI wiring as well as the lower-level renderer.
  await page.selectOption("#photo", "photo-3");
  await page.waitForFunction(
    () => window.experiment.active.id === "photo-3-level-5",
  );
  await page.selectOption("#level", "6");
  await page.waitForFunction(
    () => window.experiment.active.id === "photo-3-level-6",
  );
  for (const [id, value] of [
    ["mode", "2"],
    ["geometry", "2"],
    ["density", "416"],
    ["archStyle", "1"],
    ["animMode", "4"],
    ["animSpeed", "1.8"],
  ])
    await page.selectOption("#" + id, value);
  const settings = await page.evaluate(() => ({
    ...window.experiment.renderer.settings,
  }));
  for (const [key, value] of Object.entries({
    mode: 2,
    geometry: 2,
    columns: 416,
    rows: 144,
    archStyle: 1,
    animMode: 4,
    animSpeed: 1.8,
  }))
    assert.equal(settings[key], value);
  const motion = await page.evaluate(async () => {
    const e = window.experiment,
      r = e.renderer;
    e.automation = false;
    document.getElementById("living").checked = false;
    document.getElementById("motion").checked = false;
    const original = r.draw,
      times = [];
    r.draw = (time = 0) => {
      times.push(time);
      return original(time);
    };
    await new Promise((resolve) => setTimeout(resolve, 150));
    const pausedDraws = times.length;
    document.getElementById("living").checked = true;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const animatedDraws = times.length;
    document.getElementById("living").checked = false;
    const held = times.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const resumedPauseDraws = times.length - held;
    e.automation = true;
    r.draw = original;
    return {
      pausedDraws,
      animatedDraws,
      resumedPauseDraws,
      timeAdvanced: times.length > 1 && times.at(-1) > times[0],
    };
  });
  assert.equal(motion.pausedDraws, 0);
  assert.equal(motion.resumedPauseDraws, 0);
  assert(motion.animatedDraws > 1 && motion.timeAdvanced);
  const box = await page.locator("#view").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 45,
    box.y + box.height / 2 + 10,
  );
  await page.mouse.up();
  assert.notEqual(
    await page.evaluate(() => window.experiment.renderer.camera.yaw),
    0.22,
  );
  await page.click("#reset");
  assert.equal(
    await page.evaluate(() => window.experiment.renderer.camera.yaw),
    0,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => ({
    viewport: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert(mobile.scrollWidth <= mobile.viewport);
  assert.equal(errors.length, 0);
  const sources = [
    "assets/js/render/dome-mesh.js",
    "tools/dream-drift-ascii-renderer.mjs",
    "tools/dream-drift-ascii-viewer.mjs",
    "tools/dream-drift-ascii-gallery.html",
    "tools/dream-drift-ascii-gallery.mjs",
    "tools/experiment-dream-drift-ascii.mjs",
    "tools/verify-dream-drift-gateway-migration.mjs",
  ];
  const report = {
    status: "complete",
    operation:
      "Extract Gemini gateway demo into tracked experiment source without visual changes",
    baseline: {
      file: path.relative(root, before),
      sha256: hash(await readFile(before)),
    },
    rebuilt: {
      file: path.relative(root, after),
      sha256: hash(await readFile(after)),
    },
    matrix: {
      scenes: 9,
      archStyles: 6,
      animationModes: 5,
      speeds: [0.5, 1, 1.8],
      columns: [240, 320, 416],
      resolution: [320, 240],
      mainTimeSeconds: 3.25,
      additionalCases:
        "Image/partial/full display with smooth/relief geometry at 0 and 8 seconds; translated woven gateway",
    },
    exactPixelMatches: old.result.frames.length,
    mismatches: [],
    fixtureDigest: hash(JSON.stringify(old.result.frames)),
    controlsIdentical: true,
    rendererDefaultsIdentical: true,
    interactiveControls: {
      selection: true,
      drag: true,
      reset: true,
      motion,
      mobile,
    },
    renderer: rebuilt.result.renderer,
    errors,
    inferenceRuns: 0,
    sourceHashes: Object.fromEntries(
      await Promise.all(
        sources.map(async (file) => [
          file,
          hash(await readFile(path.join(root, file))),
        ]),
      ),
    ),
  };
  const json = JSON.stringify(report, null, 2) + "\n";
  await writeFile(
    path.join(path.dirname(after), "gateway-migration-report.json"),
    json,
  );
  await writeFile(
    path.join(root, "verification/dream-drift-gateway-migration.json"),
    json,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
