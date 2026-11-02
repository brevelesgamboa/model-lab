import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

async function open(page, context) {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  for (const file of [
    "depth-estimator.worker.js",
    "inception-feature-map.worker.js",
  ])
    await context.route(`**/${file}`, (r) =>
      r.fulfill({
        contentType: "text/javascript",
        body: `self.onmessage=({data:{bitmap}})=>{bitmap.close();self.postMessage({type:'result',width:2,height:2,depth:new Float32Array([0,1,.2,.8]),values:new Float32Array([0,.2,.8,1]),backend:'fixture',inferenceMs:1});}`,
      }),
    );
  await context.route("**/migan-inpainter.worker.js", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: `self.onmessage=async({data})=>{if(data.type==='prepare'){self.postMessage({type:'ready',backend:'fixture'});return;}const c=new OffscreenCanvas(data.bitmap.width,data.bitmap.height),ctx=c.getContext('2d');ctx.drawImage(data.bitmap,0,0);data.bitmap.close();const rgba=ctx.getImageData(0,0,c.width,c.height).data;for(let i=0;i<data.mask.length;i++)if(!data.mask[i])rgba[i*4]=Math.min(255,rgba[i*4]+70);await new Promise(r=>setTimeout(r,150));self.postMessage({type:'result',rgba,width:c.width,height:c.height},[rgba.buffer]);};`,
    }),
  );
  await page.goto("/");
  await page.locator("#quality-select").selectOption("economy");
  await page.evaluate(async () => {
    const { CorticalDreamDomeModel } =
      await import("/assets/js/models/cortical-dream-dome.js");
    const render = CorticalDreamDomeModel.prototype.render;
    CorticalDreamDomeModel.prototype.render = function (...args) {
      window.__dome = this;
      return render.apply(this, args);
    };
  });
  await page.locator("#model-select").selectOption("cortical-dream-dome");
  await page.waitForFunction(() => !!window.__dome?.graphics);
  await page.locator("#journey-enabled").check();
}

test("free photo space preserves dome controls, explores seeded passages and caches regional MI-GAN fills", async ({
  page,
  context,
}, info) => {
  test.setTimeout(120000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page, context);
  await expect(page.locator("#journey-map")).toBeVisible();
  expect(await page.locator("#journey-length").count()).toBe(0);
  expect(await page.locator("#journey-ending").count()).toBe(0);
  expect(
    await page.evaluate(() => window.__dome.controls.map((c) => c.key)),
  ).toEqual(
    expect.arrayContaining([
      "depthScale",
      "neuralSwell",
      "waveMode",
      "gain",
      "frequency",
      "speed",
      "eccentricity",
      "edgeCoupling",
      "chromaticDispersion",
      "cameraDolly",
      "featureTarget",
    ]),
  );
  await page.locator("#output-canvas").focus();
  await page.keyboard.down("w");
  await page.waitForFunction(() => window.__dome.journey.position[1] < -0.3);
  await page.keyboard.up("w");
  const away = await page.evaluate(() => window.__dome.journey.distance);
  await page.keyboard.down("s");
  await page.waitForFunction(
    (d) => window.__dome.journey.distance < d * 0.7,
    away,
  );
  await page.keyboard.up("s");
  await page.locator("#journey-home").click();
  await page.locator("#journey-look").click();
  await page.waitForFunction(() => !!document.pointerLockElement);
  const look = await page.evaluate(() => {
    document.dispatchEvent(
      new MouseEvent("mousemove", { movementX: 12, movementY: 8 }),
    );
    const { yaw, pitch } = window.__dome.camera;
    document.exitPointerLock();
    return { yaw, pitch };
  });
  expect(look.yaw).toBeGreaterThan(0);
  expect(look.pitch).toBeLessThan(0);
  await page.waitForFunction(() => !document.pointerLockElement);
  await page.locator("#journey-home").click();
  expect(await page.locator("#journey-link").count()).toBe(0);
  expect(await page.locator("#journey-section").count()).toBe(0);
  const seed = await page.locator("#journey-seed").inputValue();
  await page.locator("#journey-new").click();
  expect(await page.locator("#journey-seed").inputValue()).not.toBe(seed);
  await page.locator("#journey-seed").fill(seed);
  await page.locator("#journey-load-seed").click();
  expect(await page.locator("#journey-seed").inputValue()).toBe(seed);
  for (const id of ["recursion", "corruption", "density", "clarity"]) {
    await expect(page.locator(`#journey-${id}`)).toBeVisible();
    await page.locator(`#journey-${id}`).fill("0.7");
    await page.locator(`#journey-${id}`).dispatchEvent("input");
    expect(await page.evaluate((key) => window.__dome.journey[key], id)).toBe(
      0.7,
    );
  }
  expect(
    await page.evaluate(() =>
      Array.from(
        window.__dome.gl.getUniform(
          window.__dome.graphics.program,
          window.__dome.graphics.uniforms.viewPos,
        ),
      ),
    ),
  ).toEqual([0, 0, 0]);
  await page.locator("#journey-home").click();
  await page.locator("#dome-generate").click();
  await page.waitForFunction(
    () => window.__dome.journeyFields.state !== "baking",
  );
  expect(
    await page.evaluate(() => ({
      state: window.__dome.journeyFields.state,
      images: window.__dome.journeyFields.images.length,
      depths: window.__dome.journeyFields.depthMaps.length,
      known: window.__dome.journeyFields.metrics.map((m) => m.knownFraction),
      neural: window.__dome.journeyFields.baker.runs,
    })),
  ).toEqual({
    state: "ready",
    images: 4,
    depths: 4,
    known: [0.875, 0.875, 0.875, 0.875],
    neural: 0,
  });
  await page.locator("#dome-generate").click();
  await page.locator("#journey-cancel").click();
  expect(
    await page.evaluate(() => window.__dome.journeyFields.images.length),
  ).toBe(4);
  await page.locator("#journey-enabled").uncheck();
  await expect(page.locator("#dome-generate")).toHaveText("Synthesize Dream");
  await page.locator("#journey-enabled").check();
  await page
    .locator('[aria-label="Dream Drift"]')
    .screenshot({ path: info.outputPath("space-controls.png") });
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__dome.gl.getError())).toBe(0);
});

test("recursive passages respond to source fills and depth, preserve the source and restore prior views", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await page.route("http://127.0.0.1:8080/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Photo space verification</title>",
    }),
  );
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { CorticalDreamDomeModel } =
      await import("/assets/js/models/cortical-dream-dome.js");
    const { DREAM_REGIONS } = await import("/assets/js/models/dome-journey.js");
    const model = new CorticalDreamDomeModel();
    await model.ensureGraphics();
    const view = document.createElement("canvas");
    view.width = 320;
    view.height = 240;
    const p = Object.fromEntries(model.controls.map((c) => [c.key, c.default]));
    Object.assign(p, {
      gain: 0,
      depthScale: 0.6,
      neuralSwell: 0,
      cameraDolly: 0,
      edgeCoupling: 0,
      chromaticDispersion: 0,
    });
    const render = async () => {
      await model.render(view, p, 0);
      return view.getContext("2d").getImageData(0, 0, 320, 240).data;
    };
    const diff = (a, b, center = false) => {
      let sum = 0,
        max = 0,
        n = 0;
      for (let y = 0; y < 240; y++)
        for (let x = 0; x < 320; x++) {
          if (center && (x < 150 || x > 170 || y < 110 || y > 130)) continue;
          for (let c = 0; c < 3; c++) {
            const d = Math.abs(
              a[(y * 320 + x) * 4 + c] - b[(y * 320 + x) * 4 + c],
            );
            sum += d;
            max = Math.max(max, d);
            n++;
          }
        }
      return { mean: sum / n, max };
    };
    try {
      const baseline = await render();
      model.journey.newDream(42);
      model.journey.enabled = true;
      const home = await render();
      const scenes = [];
      for (const region of DREAM_REGIONS.slice(1)) {
        model.journey.visit(region.id);
        model.camera.yaw = region.id === "cavern" ? Math.PI : 0;
        model.camera.pitch = -0.08;
        const pixels = await render();
        scenes.push({
          id: region.id,
          pixels,
          png: view.toDataURL().split(",")[1],
        });
      }
      model.journey.visit("arches");
      model.camera.yaw = 0;
      model.camera.pitch = -0.08;
      const before = await render();
      model.journey.visit("cavern");
      await render();
      model.journey.visit("arches");
      const returned = await render();
      model.journeyFields.images = [
        "#c94040",
        "#408c50",
        "#407ec0",
        "#d0a050",
      ].map((color) => {
        const c = new OffscreenCanvas(512, 256);
        c.getContext("2d").fillStyle = color;
        c.getContext("2d").fillRect(0, 0, 512, 256);
        return c;
      });
      model.uploadJourney();
      const filled = await render();
      model.journeyFields.depthMaps = Array.from({ length: 4 }, (_, k) => ({
        width: 64,
        height: 32,
        depth: Float32Array.from(
          { length: 2048 },
          (_, i) =>
            0.5 +
            0.4 *
              Math.sin((i % 64) * 0.25 + k) *
              Math.cos(Math.floor(i / 64) * 0.3),
        ),
      }));
      model.uploadJourney();
      const depth = await render();
      model.featureMap = {
        width: 2,
        height: 2,
        values: new Float32Array([0.1, 0.8, 0.4, 1]),
      };
      model.uploadGeometry();
      const originalParams = { ...p };
      const effects = {};
      for (const [name, low, high] of [
        ["neuralSwell", { neuralSwell: 0 }, { neuralSwell: 1 }],
        ["waveMode", { gain: 0.65, waveMode: 0 }, { gain: 0.65, waveMode: 3 }],
        [
          "chromaticDispersion",
          { gain: 0.65, chromaticDispersion: 0 },
          { gain: 0.65, chromaticDispersion: 1 },
        ],
        [
          "edgeCoupling",
          { gain: 0.65, edgeCoupling: 0 },
          { gain: 0.65, edgeCoupling: 1 },
        ],
        ["cameraDolly", { cameraDolly: 0 }, { cameraDolly: 1 }],
      ]) {
        Object.assign(p, originalParams, low);
        model.journey.historyEpoch++;
        const a = await render();
        Object.assign(p, originalParams, high);
        model.journey.historyEpoch++;
        effects[name] = diff(a, await render());
      }
      Object.assign(p, originalParams);
      model.journey.home();
      model.camera.reset();
      const restored = await render();
      return {
        home: diff(home, baseline),
        restored: diff(restored, baseline),
        returned: diff(before, returned),
        fills: diff(before, filled),
        depth: diff(filled, depth),
        effects,
        distinct: scenes
          .slice(1)
          .map((s, i) => diff(s.pixels, scenes[i].pixels)),
        scenes: scenes.map(({ id, png }) => ({ id, png })),
        gl: model.gl.getError(),
        viewPosition: Array.from(
          model.gl.getUniform(
            model.graphics.program,
            model.graphics.uniforms.viewPos,
          ),
        ),
      };
    } finally {
      model.dispose();
    }
  });
  for (const scene of result.scenes)
    await writeFile(
      info.outputPath(`${scene.id}.png`),
      Buffer.from(scene.png, "base64"),
    );
  delete result.scenes;
  console.log(JSON.stringify(result));
  expect(result.home.max).toBe(0);
  expect(result.restored.max).toBe(0);
  expect(result.returned.max).toBe(0);
  expect(result.fills.mean).toBeGreaterThan(1);
  expect(result.depth.mean).toBeGreaterThan(0.01);
  for (const [name, effect] of Object.entries(result.effects))
    expect(effect.mean, name).toBeGreaterThan(0.1);
  for (const d of result.distinct) expect(d.mean).toBeGreaterThan(1);
  expect(result.gl).toBe(0);
  expect(result.viewPosition).toEqual([0, 0, 0]);
});

test("movement carries bounded image history, paused frames stay fixed and source return clears it", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await page.route("http://127.0.0.1:8080/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Recursive feedback study</title>",
    }),
  );
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { CorticalDreamDomeModel } =
      await import("/assets/js/models/cortical-dream-dome.js");
    const model = new CorticalDreamDomeModel();
    const view = document.createElement("canvas");
    view.width = 320;
    view.height = 240;
    // A detailed architectural image fixture checks that recognizable landmarks
    // survive the effect, rather than relying only on the low-detail demo.
    const ctx = model.source.getContext("2d");
    const sky = ctx.createLinearGradient(0, 0, 0, 640);
    sky.addColorStop(0, "#4a234b");
    sky.addColorStop(0.5, "#cf876f");
    sky.addColorStop(1, "#133a46");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 1024, 640);
    for (let k = 0; k < 11; k++) {
      const x = k * 100 - 16,
        top = 130 + ((k * 137) % 180);
      ctx.fillStyle = ["#20464f", "#315e65", "#795a62"][k % 3];
      ctx.fillRect(x, top, 90, 640 - top);
      for (let y = top + 10; y < 620; y += 23)
        for (let w = x + 9; w < x + 82; w += 18) {
          ctx.fillStyle = (y + w) % 5 === 0 ? "#dfb891" : "#122e3f";
          ctx.fillRect(w, y, 9, 14);
        }
    }
    ctx.fillStyle = "#c0a384";
    ctx.fillRect(420, 350, 170, 200);
    ctx.fillStyle = "#1c3946";
    ctx.beginPath();
    ctx.arc(505, 440, 52, Math.PI, 0);
    ctx.lineTo(557, 550);
    ctx.lineTo(453, 550);
    ctx.fill();
    ctx.fillStyle = "#e8bca0";
    ctx.beginPath();
    ctx.arc(750, 110, 36, 0, Math.PI * 2);
    ctx.fill();
    model.prepareSurround();
    model.uploadSource();
    const p = Object.fromEntries(model.controls.map((c) => [c.key, c.default]));
    Object.assign(p, {
      gain: 0,
      neuralSwell: 0,
      depthScale: 0,
      cameraDolly: 0,
      edgeCoupling: 0,
      chromaticDispersion: 0,
    });
    const render = async () => {
      await model.render(view, p, 0);
      return view.getContext("2d").getImageData(0, 0, 320, 240).data;
    };
    const difference = (a, b) => {
      let sum = 0,
        max = 0;
      for (let i = 0; i < a.length; i++)
        if (i % 4 !== 3) {
          const d = Math.abs(a[i] - b[i]);
          sum += d;
          max = Math.max(max, d);
        }
      return { mean: sum / (320 * 240 * 3), max };
    };
    const images = [];
    const snapshot = (name) =>
      images.push({ name, png: view.toDataURL().split(",")[1] });
    try {
      const source = await render();
      snapshot("source");
      model.journey.enabled = true;
      model.journey.newDream(42);
      model.journey.position = [0, -9];
      await render();
      snapshot("recursive-tunnel");
      const started = performance.now();
      for (let i = 0; i < 14; i++) {
        model.journey.position[1] -= 0.16;
        model.camera.yaw += 0.012;
        await render();
      }
      const frameMs = (performance.now() - started) / 14;
      const smear = await render();
      snapshot("moving-feedback");
      const validDuringMovement = model.graphics.feedback.valid;
      const repeated = await render();
      model.graphics.feedback.valid = false;
      const fresh = await render();
      snapshot("fresh-view");
      model.journey.corruption = 0;
      const noCorruption = await render();
      model.journey.recursion = 0;
      const noRecursion = await render();
      model.journey.home();
      model.camera.reset();
      const restored = await render();
      return {
        images,
        frameMs,
        validDuringMovement,
        feedback: difference(smear, fresh),
        paused: difference(smear, repeated),
        corruption: difference(fresh, noCorruption),
        recursion: difference(noCorruption, noRecursion),
        source: difference(source, restored),
        validAtHome: model.graphics.feedback.valid,
        gl: model.gl.getError(),
      };
    } finally {
      model.dispose();
    }
  });
  for (const item of result.images)
    await writeFile(
      info.outputPath(`${item.name}.png`),
      Buffer.from(item.png, "base64"),
    );
  delete result.images;
  console.log(JSON.stringify(result));
  expect(result.validDuringMovement).toBe(true);
  expect(result.feedback.mean).toBeGreaterThan(0.2);
  expect(result.paused.max).toBe(0);
  expect(result.corruption.max).toBe(0); // Corruption acts on actual history, not static photo blocks.
  expect(result.recursion.mean).toBeGreaterThan(0.2);
  expect(result.source.max).toBe(0);
  expect(result.validAtHome).toBe(false);
  expect(result.gl).toBe(0);
});
