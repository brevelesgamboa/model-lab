import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

async function blank(page) {
  await page.route("http://127.0.0.1:8080/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Dream radar verification</title>",
    }),
  );
  await page.goto("/");
}

test("ImageData uploads preserve channels and the local photo override clears stale history", async ({
  page,
}) => {
  test.setTimeout(120000);
  await blank(page);
  const result = await page.evaluate(async () => {
    const { CorticalDreamDomeModel } =
      await import("/assets/js/models/cortical-dream-dome.js");
    const { probeCanvasRedBlue } =
      await import("/assets/js/render/dome-color-probe.js");
    const nativeUpload = WebGL2RenderingContext.prototype.texImage2D;
    const runs = [];
    try {
      for (const swapped of [false, true]) {
        let surfaceUploads = 0,
          byteUploads = 0;
        WebGL2RenderingContext.prototype.texImage2D = function (...args) {
          // Emulate the driver defect only for DOM image uploads; depth arrays
          // and framebuffer copies retain their original channel order.
          if (args.length === 6 && args[5]?.getContext) {
            surfaceUploads++;
          }
          if (args.length === 9 && args[8] instanceof Uint8ClampedArray)
            byteUploads++;
          // Small software surfaces remain correct: the previous 1px probe
          // could miss this size-dependent defect entirely.
          if (
            swapped &&
            args.length === 6 &&
            args[5]?.getContext &&
            args[5].width >= 64 &&
            args[5].height >= 64
          ) {
            const source = args[5],
              c = new OffscreenCanvas(source.width, source.height);
            const ctx = c.getContext("2d");
            ctx.drawImage(source, 0, 0);
            const image = ctx.getImageData(0, 0, c.width, c.height);
            for (let i = 0; i < image.data.length; i += 4)
              [image.data[i], image.data[i + 2]] = [
                image.data[i + 2],
                image.data[i],
              ];
            ctx.putImageData(image, 0, 0);
            args[5] = c;
          }
          return nativeUpload.apply(this, args);
        };
        const model = new CorticalDreamDomeModel();
        model.colorSwapRB = false;
        const view = document.createElement("canvas");
        view.width = 64;
        view.height = 48;
        const p = Object.fromEntries(
          model.controls.map((c) => [c.key, c.default]),
        );
        Object.assign(p, {
          gain: 0,
          depthScale: 0,
          neuralSwell: 0,
          cameraDolly: 0,
          edgeCoupling: 0,
          chromaticDispersion: 0,
        });
        try {
          const ctx = model.source.getContext("2d");
          ctx.fillStyle = "#d03919";
          ctx.fillRect(0, 0, model.source.width, model.source.height);
          ctx.fillStyle = "#2273b5";
          ctx.fillRect(0, 0, model.source.width / 2, model.source.height / 2);
          model.prepareSurround();
          await model.ensureGraphics();
          model.uploadSource();
          const gl = model.gl;
          const snapshot = () => [
            gl.getParameter(gl.ACTIVE_TEXTURE),
            gl.getParameter(gl.TEXTURE_BINDING_2D),
            gl.getParameter(gl.CURRENT_PROGRAM),
            gl.getParameter(gl.VERTEX_ARRAY_BINDING),
            gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
            gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
            ...gl.getParameter(gl.VIEWPORT),
            ...gl.getParameter(gl.COLOR_WRITEMASK),
            gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL),
            gl.isEnabled(gl.BLEND),
            gl.isEnabled(gl.DEPTH_TEST),
            gl.isEnabled(gl.SCISSOR_TEST),
            gl.isEnabled(gl.CULL_FACE),
          ];
          gl.activeTexture(gl.TEXTURE7);
          gl.viewport(2, 3, 17, 19);
          gl.enable(gl.SCISSOR_TEST);
          gl.colorMask(false, true, false, true);
          const before = snapshot(),
            probe = probeCanvasRedBlue(gl),
            after = snapshot();
          gl.disable(gl.SCISSOR_TEST);
          gl.colorMask(true, true, true, true);
          const frames = [];
          const capture = async () => {
            await model.render(view, p, 0);
            frames.push(
              Array.from(view.getContext("2d").getImageData(0, 0, 64, 48).data),
            );
          };
          await capture();
          model.colorSwapRB = true;
          await model.render(view, p, 0);
          const manual = view.getContext("2d").getImageData(0, 0, 64, 48).data;
          let manualError = 0;
          for (let i = 0; i < manual.length; i += 4) {
            manualError = Math.max(
              manualError,
              Math.abs(manual[i] - frames[0][i + 2]),
              Math.abs(manual[i + 1] - frames[0][i + 1]),
              Math.abs(manual[i + 2] - frames[0][i]),
            );
          }
          const manualUniform = gl.getUniform(
            model.graphics.program,
            model.graphics.uniforms.swap_rb,
          );
          model.colorSwapRB = false;
          model.outpaintingMode = "migan";
          await capture();
          model.journey.enabled = true;
          model.journey.newDream(42);
          model.journey.corruption = 0;
          model.journey.depthFog = model.journey.depthContours = 0;
          model.journey.clarity = 1;
          model.journey.position = [0, -9];
          await capture();
          model.journey.clarity = 0.4;
          model.journey.corruption = 1;
          for (let i = 0; i < 2; i++) {
            model.journey.position[1] -= 0.1;
            await capture();
          }
          const validHistory = model.graphics.feedback.valid;
          model.colorSwapRB = true;
          await model.render(view, p, 0);
          const historyClearedOn = !model.graphics.feedback.valid;
          model.colorSwapRB = false;
          await model.render(view, p, 0);
          const historyClearedOff = !model.graphics.feedback.valid;
          model.journey.home();
          model.journey.startWarp("0,-1");
          model.journey.advanceWarp(2.5);
          await capture();
          runs.push({
            probe,
            restored: before.every((v, i) => v === after[i]),
            validHistory,
            manualError,
            manualUniform,
            historyClearedOn,
            historyClearedOff,
            surfaceUploads,
            byteUploads,
            frames,
            gl: gl.getError(),
          });
        } finally {
          model.dispose();
        }
      }
    } finally {
      WebGL2RenderingContext.prototype.texImage2D = nativeUpload;
    }
    const differences = runs[0].frames.map((a, k) =>
      Math.max(...a.map((v, i) => Math.abs(v - runs[1].frames[k][i]))),
    );
    return {
      differences,
      probes: runs.map(({ frames: _frames, ...run }) => ({
        ...run,
      })),
    };
  });
  console.log(JSON.stringify(result));
  expect(result.probes[0].probe.swapRB).toBe(0);
  expect(result.probes[1].probe.swapRB).toBe(1);
  for (const run of result.probes) {
    expect(run.restored).toBe(true);
    expect(run.validHistory).toBe(true);
    expect(run.manualError).toBe(0);
    expect(run.manualUniform).toBe(1);
    expect(run.historyClearedOn).toBe(true);
    expect(run.historyClearedOff).toBe(true);
    expect(run.surfaceUploads).toBe(1); // Only the explicit diagnostic probe.
    expect(run.byteUploads).toBeGreaterThanOrEqual(12);
    expect(run.gl).toBe(0);
  }
  expect(result.differences).toEqual([0, 0, 0, 0, 0, 0]);
});

test("HTML and offscreen photo bytes retain RGBA channels and vertical orientation", async ({
  page,
}) => {
  await blank(page);
  const result = await page.evaluate(async () => {
    const { uploadDream360 } =
      await import("/assets/js/models/inception-dream-bake.js");
    const canvas = document.createElement("canvas"),
      gl = canvas.getContext("webgl2");
    const fb = gl.createFramebuffer(),
      texture = gl.createTexture(),
      results = [];
    try {
      for (const photo of [
        document.createElement("canvas"),
        new OffscreenCanvas(128, 96),
      ]) {
        photo.width = 128;
        photo.height = 96;
        const ctx = photo.getContext("2d");
        for (const [color, x, y] of [
          ["#ff0000", 0, 0],
          ["#00ff00", 64, 0],
          ["#0000ff", 0, 48],
          ["#ffff00", 64, 48],
        ]) {
          ctx.fillStyle = color;
          ctx.fillRect(x, y, 64, 48);
        }
        uploadDream360(gl, texture, photo);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          texture,
          0,
        );
        if (
          gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE
        )
          throw new Error("Photo texture is incomplete");
        const pixel = new Uint8Array(4),
          corners = [];
        for (const [x, y] of [
          [0, 95],
          [127, 95],
          [0, 0],
          [127, 0],
        ]) {
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          corners.push([...pixel]);
        }
        results.push(corners);
      }
      return { corners: results, gl: gl.getError() };
    } finally {
      gl.deleteFramebuffer(fb);
      gl.deleteTexture(texture);
    }
  });
  expect(result.corners).toEqual(
    Array(2).fill([
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [255, 255, 0, 255],
    ]),
  );
  expect(result.gl).toBe(0);
});

test("warp chamber has visible photo-derived motion, opens at the exit, and resolves exactly to the destination", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await blank(page);
  const result = await page.evaluate(async () => {
    const { CorticalDreamDomeModel } =
      await import("/assets/js/models/cortical-dream-dome.js");
    const model = new CorticalDreamDomeModel(),
      view = document.createElement("canvas");
    view.width = 192;
    view.height = 144;
    const p = Object.fromEntries(model.controls.map((c) => [c.key, c.default]));
    Object.assign(p, {
      gain: 0.3,
      cameraDolly: 0,
      neuralSwell: 0,
      chromaticDispersion: 0.2,
    });
    model.journey.enabled = true;
    model.journey.newDream(42);
    model.journey.corruption = 0;
    model.journey.clarity = 0.35;
    const images = [],
      frames = [];
    const render = async (name) => {
      await model.render(view, p, 0);
      const frame = view
        .getContext("2d")
        .getImageData(0, 0, view.width, view.height).data;
      if (name) images.push({ name, png: view.toDataURL().split(",")[1] });
      return frame;
    };
    const diff = (a, b) => {
      let total = 0,
        max = 0;
      for (let i = 0; i < a.length; i++)
        if (i % 4 !== 3) {
          const d = Math.abs(a[i] - b[i]);
          total += d;
          max = Math.max(max, d);
        }
      return { mean: total / (view.width * view.height * 3), max };
    };
    try {
      const source = await render("source"),
        target = [...model.journey.discovered.get("0,-1").position];
      model.journey.startWarp("0,-1");
      const start = await render("warp-0");
      for (const seconds of [1, 1.5, 1.75, 0.4, 0.345, 0.005]) {
        model.journey.advanceWarp(seconds);
        frames.push(
          await render(`warp-${model.journey.warpProgress.toFixed(3)}`),
        );
      }
      const arrival = frames.at(-1),
        validAtArrival = model.graphics.feedback.valid;
      model.journey.home();
      const restored = await render();
      model.journey.position = target;
      const direct = await render("destination-direct");
      const differences = frames
        .slice(1)
        .map((frame, i) => diff(frame, frames[i]));
      return {
        images,
        start: diff(source, start),
        restored: diff(source, restored),
        arrival: diff(arrival, direct),
        nearExit: diff(frames.at(-2), arrival),
        differences,
        validAtArrival,
        gl: model.gl.getError(),
        dark: frames.map(
          (f) =>
            [...f].filter((v, i) => i % 4 !== 3 && v < 8).length /
            (view.width * view.height * 3),
        ),
        clipped: frames.map(
          (f) =>
            [...f].filter((v, i) => i % 4 !== 3 && v === 255).length /
            (view.width * view.height * 3),
        ),
      };
    } finally {
      model.dispose();
    }
  });
  for (const image of result.images)
    await writeFile(
      info.outputPath(`${image.name}.png`),
      Buffer.from(image.png, "base64"),
    );
  delete result.images;
  console.log(JSON.stringify(result));
  expect(result.start.max).toBe(0);
  expect(result.restored.max).toBe(0);
  expect(result.arrival.max).toBe(0);
  expect(result.nearExit.mean).toBeLessThan(0.5);
  expect(result.differences[0].mean).toBeGreaterThan(1);
  expect(result.validAtArrival).toBe(false);
  expect(Math.max(...result.dark)).toBeLessThan(0.5);
  expect(Math.max(...result.clipped)).toBeLessThan(0.25);
  expect(result.gl).toBe(0);
});

test("radar layer buttons, scaled hit targets, five-second navigation and cancellation work with paused scene time", async ({
  page,
  context,
}, info) => {
  test.setTimeout(120000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.clock.install();
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
  // Actual GPU frames are verified above. Keep timing/input tests independent
  // of the software renderer's throughput and hold the scene clock at zero.
  await page.evaluate(() => {
    const m = window.__dome;
    m.render = async () => ({ backend: m.backend });
    m.newJourney(42);
  });
  await page.locator("#journey-enabled").check();
  const map = page.locator("#journey-map");
  await map.scrollIntoViewIfNeeded();
  await page
    .locator('[aria-label="Dream Drift"]')
    .screenshot({ path: info.outputPath("radar-controls.png") });
  const image = () =>
    page.evaluate(() => document.querySelector("#journey-map").toDataURL());
  for (const id of ["geo", "net", "trace"]) {
    const button = page.locator(`#journey-${id}`),
      before = await image();
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    if (id !== "trace") expect(await image()).not.toBe(before);
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
  async function clickNode(id) {
    const point = await page.evaluate((id) => {
      const c = document.querySelector("#journey-map"),
        j = window.__dome.journey;
      const rect = c.getBoundingClientRect(),
        node = j.discovered.get(id);
      const scale = Math.min(c.width, c.height - 28) / 96;
      return {
        x:
          ((c.width / 2 + (node.position[0] - j.position[0]) * scale) *
            rect.width) /
          c.width,
        y:
          ((c.height / 2 + 9 + (node.position[1] - j.position[1]) * scale) *
            rect.height) /
          c.height,
      };
    }, id);
    await map.click({ position: point });
  }
  await page.evaluate(() => {
    document.querySelector("#journey-map").style.width = "220px";
  });
  const started = Date.now();
  await clickNode("0,-1");
  await expect(page.locator("#journey-status")).toContainText("Warping");
  await expect(page.locator("#journey-look")).toBeDisabled();
  await expect(page.locator("#dome-generate")).toBeDisabled();
  await expect(page.locator("#dome-reset-view")).toBeDisabled();
  const textureDrawer = page
    .locator("#journey-options details")
    .filter({ has: page.locator("#journey-swap-rb") });
  await textureDrawer.locator("summary").click();
  await page.locator("#journey-swap-rb").check();
  expect(await page.evaluate(() => window.__dome.colorSwapRB)).toBe(true);
  await page.locator("#journey-swap-rb").uncheck();
  expect(await page.evaluate(() => window.__dome.colorSwapRB)).toBe(false);
  const locks = await page.evaluate(() => {
    const m = window.__dome,
      c = document.querySelector("#output-canvas");
    const before = [
      m.camera.yaw,
      m.camera.pitch,
      m.camera.scrollDolly,
      ...m.journey.position,
    ];
    c.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyW", key: "w", bubbles: true }),
    );
    c.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "ArrowLeft",
        key: "ArrowLeft",
        bubbles: true,
      }),
    );
    c.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }));
    c.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerId: 1,
        button: 0,
        clientX: 10,
        clientY: 10,
        bubbles: true,
      }),
    );
    c.dispatchEvent(
      new PointerEvent("pointermove", {
        pointerId: 1,
        clientX: 100,
        clientY: 90,
        bubbles: true,
      }),
    );
    document.dispatchEvent(
      new MouseEvent("mousemove", { movementX: 100, movementY: 90 }),
    );
    return {
      before,
      after: [
        m.camera.yaw,
        m.camera.pitch,
        m.camera.scrollDolly,
        ...m.journey.position,
      ],
    };
  });
  expect(locks.after).toEqual(locks.before);
  await page.waitForFunction(() => !window.__dome.journey.warping, null, {
    timeout: 7000,
  });
  const elapsed = (Date.now() - started) / 1000;
  expect(elapsed).toBeGreaterThanOrEqual(4.9);
  expect(elapsed).toBeLessThan(6.5);
  const arrival = await page.evaluate(() => {
    const j = window.__dome.journey;
    return {
      position: j.position,
      target: j.discovered.get("0,-1").position,
      visited: j.visited.has("0,-1"),
      expanded: j.discovered.has("0,-2"),
    };
  });
  expect(arrival).toMatchObject({ visited: true, expanded: true });
  expect(arrival.position).toEqual(arrival.target);
  await page
    .locator('[aria-label="Dream Drift"]')
    .screenshot({ path: info.outputPath("radar-arrival.png") });
  const traceBefore = await image();
  await page.locator("#journey-trace").click();
  expect(await image()).not.toBe(traceBefore);
  await page.locator("#journey-trace").click();
  await clickNode("0,0");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => window.__dome.journey.warping)).toBe(false);
  await clickNode("0,-2");
  await page.locator("#journey-home").click();
  expect(
    await page.evaluate(() => [
      window.__dome.journey.warping,
      ...window.__dome.journey.position,
    ]),
  ).toEqual([false, 0, 0]);
  await page.clock.fastForward(60000);
  expect(
    await page.evaluate(() => window.__dome.journey.breadcrumbs.length),
  ).toBe(0);
  await page.clock.resume();
  // Keyboard access selects only visible network targets; NET off blocks it.
  await map.focus();
  await page.keyboard.press("ArrowRight");
  await page.locator("#journey-net").click();
  await map.focus();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => window.__dome.journey.warping)).toBe(false);
  await page.locator("#journey-net").click();
  await map.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => window.__dome.journey.warping)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  expect(await page.evaluate(() => window.__dome.journey.warping)).toBe(false);
  await clickNode("0,-1");
  await page.locator("#dome-demo").click();
  expect(
    await page.evaluate(() => [
      window.__dome.journey.warping,
      ...window.__dome.journey.position,
    ]),
  ).toEqual([false, 0, 0]);
  await clickNode("0,-1");
  await page.locator('[data-view="about"]').click();
  await page.waitForFunction(() => !window.__dome.journey.warping);
  expect(errors).toEqual([]);
});
