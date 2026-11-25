import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function state(page) {
  return page.evaluate(async () => {
    const runtime = window.__growthRuntime;
    const hash = await crypto.subtle.digest("SHA-256", runtime.readState());
    return {
      steps: runtime.getStats().steps,
      size: runtime.size,
      seed: runtime.seed,
      hash: [...new Uint8Array(hash)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.abort(),
  );
  await page.goto("/");
  await expect(page.locator("#status-message")).toContainText("ready");
  await expect(page.locator("#toggle-animation")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.locator("#toggle-animation")).toHaveText("CLOCK: OFF");
  // Observe the actual production runtime without exposing app internals.
  await page.evaluate(async () => {
    const { TextureNcaRuntime } =
      await import("/assets/js/models/neural-growth/runtime.js");
    const draw = TextureNcaRuntime.prototype.draw;
    TextureNcaRuntime.prototype.draw = function (...args) {
      window.__growthRuntime = this;
      return draw.apply(this, args);
    };
  });
});

async function selectGrowth(page, { expandSections = true } = {}) {
  await page.locator("#model-select").selectOption("neural-growth");
  await expect(page.locator("#step-growth")).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-size",
    "256",
  );
  if (expandSections) {
    for (const section of await page.locator(".control-section").all()) {
      if ((await section.getAttribute("open")) === null) {
        await section.locator(":scope > summary").click();
      }
    }
  }
}

test("growth sections default to Pattern and keep brush settings in the right rail", async ({
  page,
}) => {
  await selectGrowth(page, { expandSections: false });
  await expect(page.locator(".control-section > summary")).toHaveText([
    "Pattern",
    "Geometry",
    "Temporal",
    "Display",
    "Simulation",
  ]);
  await expect(page.locator(".control-section[open] > summary")).toHaveText([
    "Pattern",
  ]);
  await expect(page.locator(".model-readout")).not.toHaveAttribute("open");
  await expect(page.getByLabel("GROWTH SPEED", { exact: true })).toBeVisible();
  await expect(page.getByLabel("ROTATION", { exact: true })).toBeHidden();
  for (const key of [
    "brushRadius",
    "disturbanceMode",
    "dyeColor",
    "barrierOutline",
    "barrierLock",
  ]) {
    await expect(
      page.locator(`#parameter-controls [data-parameter="${key}"]`),
    ).toHaveCount(0);
  }
  await page.locator("#step-growth").click();
  const before = await state(page);
  await page.locator('[data-section="geometry"] > summary').click();
  await page.getByLabel("ROTATION exact value", { exact: true }).fill("60");
  await expect(page.locator('[data-section="dream"]')).toHaveCount(0);
  await expect(page.locator(".neuron-gallery")).toHaveCount(0);
  await page.locator("#brush-settings > summary").click();
  const brush = page.getByLabel("Brush mode", { exact: true });
  await expect(brush.locator("option")).toHaveCount(10);
  for (const mode of ["invert", "infuse", "prune", "freeze", "dye"]) {
    await brush.selectOption(mode);
    await expect(brush).toHaveValue(mode);
    await expect(page.locator('[data-section="geometry"]')).toHaveAttribute(
      "open",
      "",
    );
    await expect(page.locator('[data-section="dream"]')).toHaveCount(0);
  }
  await page.locator("#growth-brush-radius").fill("24");
  await expect(page.locator("#growth-brush-radius-val")).toHaveText("24px");
  expect(await state(page)).toEqual(before);
  await page.reload();
  await expect(page.locator("#status-message")).toContainText("ready");
  await selectGrowth(page, { expandSections: false });
  await expect(page.locator('[data-section="geometry"]')).toHaveAttribute(
    "open",
    "",
  );
  await expect(page.locator('[data-section="dream"]')).toHaveCount(0);
});

test("growth uploads fractional pan and integer step uniforms without WebGL errors", async ({
  page,
}) => {
  await selectGrowth(page);
  const result = await page.evaluate(() => {
    const runtime = window.__growthRuntime;
    const gl = runtime.gl;
    const errors = [gl.getError()];
    runtime.step(2);
    errors.push(gl.getError());
    runtime.draw(document.getElementById("output-canvas"), {
      zoom: 2,
      pan: [0.125, -0.0625],
    });
    errors.push(gl.getError());
    return {
      errors,
      resonanceUniform:
        gl.getUniformLocation(
          runtime.program.update.handle,
          "u_resonanceFeedback",
        ) !== null,
      legacyUniform:
        gl.getUniformLocation(
          runtime.program.update.handle,
          "u_latentFeedback",
        ) !== null,
      pan: Array.from(
        gl.getUniform(
          runtime.program.visualize.handle,
          runtime.program.visualize.locations.get("u_pan"),
        ),
      ),
    };
  });
  expect(result.errors).toEqual([0, 0, 0]);
  expect(result.resonanceUniform).toBe(true);
  expect(result.legacyUniform).toBe(false);
  expect(result.pan).toEqual([0.125, -0.0625]);
});

test("the compact drawer animates without measuring history charts", async ({
  page,
}) => {
  await selectGrowth(page);
  const control = page.locator('[data-parameter="growthSpeed"]');
  await control.locator(".modulation-toggle").click();
  await control
    .getByLabel("GROWTH SPEED modulation enabled", { exact: true })
    .check();
  const line = control.locator(".drawer-playhead");
  const before = await line.getAttribute("x1");
  await expect.poll(() => line.getAttribute("x1")).not.toBe(before);
  await expect(page.locator(".modulation-visualizer")).toHaveCount(0);
  await expect(page.locator(".existing-routing")).toHaveCount(0);
  await page.locator("#toggle-animation").click();
});

async function displaySize(page) {
  return page.locator("#output-canvas").evaluate((canvas) => ({
    width: canvas.width,
    height: canvas.height,
    runtimeWidth: window.__growthRuntime.canvas.width,
    runtimeHeight: window.__growthRuntime.canvas.height,
  }));
}

test("live display caps honor quality and model switches without changing the NCA grid", async ({
  page,
}) => {
  await selectGrowth(page);
  await page.getByLabel("GROWTH SPEED exact value", { exact: true }).fill("0");
  await page.locator("#quality-select").selectOption("extreme");
  await expect
    .poll(() => displaySize(page))
    .toEqual({
      width: 1536,
      height: 1536,
      runtimeWidth: 1536,
      runtimeHeight: 1536,
    });
  const before = await state(page);
  await page.locator("#toggle-animation").click();
  await expect
    .poll(() => displaySize(page))
    .toEqual({
      width: 768,
      height: 768,
      runtimeWidth: 768,
      runtimeHeight: 768,
    });
  await page.locator("#quality-select").selectOption("economy");
  await expect
    .poll(() => displaySize(page))
    .toEqual({
      width: 384,
      height: 384,
      runtimeWidth: 384,
      runtimeHeight: 384,
    });
  await page.locator("#quality-select").selectOption("extreme");
  await expect
    .poll(() => displaySize(page))
    .toEqual({
      width: 768,
      height: 768,
      runtimeWidth: 768,
      runtimeHeight: 768,
    });
  await page.locator("#model-select").selectOption("folded-fractal");
  await expect(page.locator("#output-canvas")).toHaveAttribute("width", "1536");
  await selectGrowth(page);
  await expect
    .poll(() => displaySize(page))
    .toEqual({
      width: 768,
      height: 768,
      runtimeWidth: 768,
      runtimeHeight: 768,
    });
  await page.locator("#toggle-animation").click();
  await expect
    .poll(() => displaySize(page))
    .toEqual({
      width: 1536,
      height: 1536,
      runtimeWidth: 1536,
      runtimeHeight: 1536,
    });
  expect(await state(page)).toEqual(before);
});

test.describe("Neural Growth fullscreen display resolution", () => {
  test.use({ deviceScaleFactor: 2 });

  test("high-DPR playback stays capped through resize and restores paused detail", async ({
    page,
  }) => {
    await selectGrowth(page);
    await page
      .getByLabel("GROWTH SPEED exact value", { exact: true })
      .fill("0");
    await page.locator("#quality-select").selectOption("extreme");
    const before = await state(page);
    await page.locator("#toggle-animation").click();
    await page.locator("#toggle-fullscreen").click();
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement?.id))
      .toBe("output-panel");
    async function checkFullscreen() {
      await expect
        .poll(async () => {
          const { width, height } = await displaySize(page);
          return Math.max(width, height);
        })
        .toBe(768);
      await expect
        .poll(() =>
          page.locator("#output-canvas").evaluate((canvas) => {
            const bounds = canvas.getBoundingClientRect();
            return Math.abs(
              bounds.width / bounds.height - canvas.width / canvas.height,
            );
          }),
        )
        .toBeLessThan(0.01);
    }
    await checkFullscreen();
    // Chromium disallows native window resizing while fullscreen. Resize its
    // emulated viewport instead, which still delivers the app's resize event.
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 900,
      height: 1200,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await checkFullscreen();
    await page.keyboard.press("Space");
    await expect
      .poll(async () => {
        const { width, height } = await displaySize(page);
        return Math.max(width, height);
      })
      .toBeGreaterThan(768);
    expect(await state(page)).toEqual(before);
    await page.keyboard.press("Space");
    await checkFullscreen();
    await page.keyboard.press("f");
    await expect
      .poll(() => displaySize(page))
      .toEqual({
        width: 768,
        height: 768,
        runtimeWidth: 768,
        runtimeHeight: 768,
      });
    expect(await state(page)).toEqual(before);
  });
});

test("PNG exports retain current, 2K and 4K sizes while live growth remains capped", async ({
  page,
}) => {
  await selectGrowth(page);
  await page.getByLabel("GROWTH SPEED exact value", { exact: true }).fill("0");
  await page.locator("#quality-select").selectOption("extreme");
  await page.locator("#toggle-animation").click();
  await expect
    .poll(() => displaySize(page))
    .toEqual({
      width: 768,
      height: 768,
      runtimeWidth: 768,
      runtimeHeight: 768,
    });
  const before = await state(page);
  await page.evaluate(() => {
    window.__growthDraws = [];
    const runtime = window.__growthRuntime;
    const draw = runtime.draw;
    runtime.draw = function (canvas, options) {
      const live = document.getElementById("output-canvas");
      window.__growthDraws.push({
        width: canvas.width,
        height: canvas.height,
        liveWidth: live.width,
        liveHeight: live.height,
      });
      return draw.call(this, canvas, options);
    };
  });
  for (const [resolution, size] of [
    ["current", 768],
    ["2048", 2048],
    ["4096", 4096],
  ]) {
    await page.locator("#save-image").click();
    await page
      .locator(`input[name="export-resolution"][value="${resolution}"]`)
      .check();
    const downloaded = page.waitForEvent("download");
    await page.locator("#export-modal-confirm").click();
    const download = await downloaded;
    const bytes = await readFile(await download.path());
    expect(bytes.readUInt32BE(16)).toBe(size);
    expect(bytes.readUInt32BE(20)).toBe(size);
    await expect
      .poll(() => displaySize(page))
      .toEqual({
        width: 768,
        height: 768,
        runtimeWidth: 768,
        runtimeHeight: 768,
      });
    expect(await state(page)).toEqual(before);
  }
  const draws = await page.evaluate(() => window.__growthDraws);
  expect(draws.map(({ width }) => width)).toEqual(
    expect.arrayContaining([768, 2048, 4096]),
  );
  expect(
    draws.every(
      ({ liveWidth, liveHeight }) => liveWidth === 768 && liveHeight === 768,
    ),
  ).toBe(true);
});

test("display resizing and snapshots preserve echo history and simulation state", async ({
  page,
}) => {
  await selectGrowth(page);
  await page.getByLabel("GROWTH SPEED exact value", { exact: true }).fill("0");
  await page.locator("#quality-select").selectOption("ultra");
  await page
    .getByLabel("TEMPORAL ECHO DECAY exact value", { exact: true })
    .fill("0.6");
  await expect
    .poll(() =>
      page.evaluate(() => window.__growthRuntime.echoTargets?.[0].width),
    )
    .toBe(768);
  const before = await state(page);
  const resources = await page.evaluate(() => {
    window.__echoHistory = window.__growthRuntime.echoTargets;
    return window.__growthRuntime.getStats().resources;
  });
  for (let cycle = 0; cycle < 3; cycle += 1) {
    for (const width of [768, 1024]) {
      await page.locator("#toggle-animation").click();
      await expect.poll(() => displaySize(page)).toMatchObject({ width });
      expect(
        await page.evaluate(
          () => window.__growthRuntime.echoTargets === window.__echoHistory,
        ),
      ).toBe(true);
    }
    expect(
      await page.evaluate(() => window.__growthRuntime.getStats().resources),
    ).toEqual(resources);
  }
  const preserved = await page.evaluate(async () => {
    const runtime = window.__growthRuntime;
    const history = runtime.echoTargets;
    const index = runtime.echoIndex;
    async function hashes() {
      return Promise.all(
        history.map(async (target) => {
          const pixels = new Uint8Array(target.width * target.height * 4);
          const gl = runtime.gl;
          gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
          gl.readPixels(
            0,
            0,
            target.width,
            target.height,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            pixels,
          );
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          return Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", pixels)),
          ).join(",");
        }),
      );
    }
    const before = await hashes();
    for (const extent of [2048, 4096]) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = extent;
      runtime.draw(canvas, { echoDecay: 0.6, preserveEchoHistory: true });
    }
    return {
      sameTargets: runtime.echoTargets === history,
      sameIndex: runtime.echoIndex === index,
      before,
      after: await hashes(),
      error: runtime.gl.getError(),
    };
  });
  expect(preserved.sameTargets).toBe(true);
  expect(preserved.sameIndex).toBe(true);
  expect(preserved.after).toEqual(preserved.before);
  expect(preserved.error).toBe(0);
  expect(await state(page)).toEqual(before);
});

test("a lost WebGL context requires explicit retry and releases the old runtime", async ({
  page,
}) => {
  await selectGrowth(page);
  await page.evaluate(() => {
    window.__lostRuntime = window.__growthRuntime;
    window.__lostRuntime.gl.getExtension("WEBGL_lose_context").loseContext();
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.__lostRuntime.getStats().contextLost),
    )
    .toBe(true);
  await page
    .getByLabel("DISPLAY PALETTE", { exact: true })
    .selectOption("spectral");
  await expect(page.locator("#growth-status")).toContainText(
    "context was lost",
  );
  await expect(page.locator("#step-growth")).toBeDisabled();
  await page.locator("#restart-growth").click();
  await expect(page.locator("#step-growth")).toBeEnabled();
  expect(
    await page.evaluate(() => window.__lostRuntime.getStats().disposed),
  ).toBe(true);
  expect(
    await page.evaluate(() => window.__growthRuntime.getStats().contextLost),
  ).toBe(false);
});

test("switching away during a delayed checkpoint load cannot paint the new route", async ({
  page,
}) => {
  let release;
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/models/neural-growth/checkpoint.json", async (route) => {
    started();
    await waiting;
    await route.continue();
  });
  await page.locator("#model-select").selectOption("neural-growth");
  await entered;
  await page.locator("#model-select").selectOption("folded-fractal");
  await expect(page.locator("#status-message")).toContainText("ready");
  const before = await page
    .locator("#output-canvas")
    .evaluate((canvas) => canvas.toDataURL());
  release();
  await page.waitForTimeout(100);
  expect(
    await page
      .locator("#output-canvas")
      .evaluate((canvas) => canvas.toDataURL()),
  ).toBe(before);
  expect(await page.evaluate(() => window.__growthRuntime)).toBeUndefined();
});

test("Growth controls, switching, navigation and viewport changes preserve GPU state", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await selectGrowth(page);
  await expect(page.locator(".modulation-toggle:visible")).toHaveCount(15);
  await expect(page.locator("#save-gif")).toBeDisabled();
  await expect(page.locator("#run-experiment")).toBeEnabled();
  await expect(page.locator("#randomize-all")).toBeHidden();
  await page.locator("#step-growth").click();
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-steps",
    "1",
  );
  const before = await state(page);
  await page
    .getByLabel("DISPLAY PALETTE", { exact: true })
    .selectOption("spectral");
  await page.getByLabel("GROWTH SPEED exact value", { exact: true }).fill("60");
  await page.getByLabel("ROTATION exact value", { exact: true }).fill("90");
  await page
    .getByLabel("GRID TOPOLOGY", { exact: true })
    .selectOption("hexagonal");
  await page.getByLabel("ZOOM", { exact: true }).selectOption("2");
  await page.getByLabel("SEED", { exact: true }).fill("");
  await page.locator("#quality-select").selectOption("economy");
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.waitForTimeout(150);
  expect(await state(page)).toEqual(before);
  for (const view of ["saved", "experiments", "about", "lab"]) {
    await page.locator(`[data-view="${view}"]`).click();
  }
  await page.locator("#model-select").selectOption("folded-fractal");
  await expect(page.locator("#growth-tools")).toBeHidden();
  await expect(page.locator("#save-gif")).toBeEnabled();
  await expect(page.locator("#run-experiment")).toBeEnabled();
  await selectGrowth(page);
  expect(await state(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test("PNG is an immutable snapshot and experiment runs save to archive", async ({
  page,
  request,
}) => {
  await selectGrowth(page);
  await page.locator("#step-growth").click();
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-steps",
    "1",
  );
  const before = await state(page);
  await page.locator("#save-image").click();
  await expect(page.locator("#export-option-2k input")).toBeEnabled();
  const download = page.waitForEvent("download");
  await page.locator("#export-modal-confirm").click();
  expect((await download).suggestedFilename()).toMatch(
    /^Neural_Growth_.*\.png$/,
  );
  await expect(page.locator("#status-message")).toContainText(
    "PNG snapshot exported",
  );
  expect(await state(page)).toEqual(before);
  await page.keyboard.press("Control+Enter");
  await expect(page.locator("#status-message")).toContainText("saved");
  await page.locator('[data-view="saved"]').click();
  await expect(page.locator(".run-card")).toHaveCount(1);
  for (const [asset, text] of [
    ["/models/neural-growth/NOTICE.md", "CC-BY-4.0"],
    ["/licenses/neural-growth-Apache-2.0.txt", "Apache License"],
  ]) {
    const response = await request.get(asset);
    expect(response).toBeOK();
    expect(await response.text()).toContain(text);
  }
  await page.locator('[data-view="lab"]').click();
  await page.locator("#model-select").selectOption("folded-fractal");
  await page.locator("#save-image").click();
  await expect(page.locator("#export-option-2k input")).toBeEnabled();
});

test("live growth pauses without catch-up; seed, grid and restart reset only explicitly", async ({
  page,
}) => {
  await selectGrowth(page);
  await page.locator("#toggle-animation").click();
  await expect.poll(async () => (await state(page)).steps).toBeGreaterThan(3);
  await page.locator('[data-view="about"]').click();
  const hidden = await state(page);
  await page.waitForTimeout(200);
  expect(await state(page)).toEqual(hidden);
  await page.locator('[data-view="lab"]').click();
  await page.locator("#toggle-animation").click();
  await expect(page.locator("#toggle-animation")).toHaveText("CLOCK: OFF");
  const paused = await state(page);
  await page.waitForTimeout(200);
  expect(await state(page)).toEqual(paused);
  await page.locator("#disturb-growth").click();
  await expect(page.locator("#step-growth")).toBeEnabled();
  const disturbed = await state(page);
  expect(disturbed.steps).toBe(paused.steps);
  expect(disturbed.hash).not.toBe(paused.hash);
  await page.getByLabel("SEED", { exact: true }).fill("42");
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-steps",
    "0",
  );
  expect((await state(page)).seed).toBe(42);
  await page.getByLabel("SIMULATION GRID", { exact: true }).selectOption("128");
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-size",
    "128",
  );
  expect((await state(page)).steps).toBe(0);
  await page.locator("#step-growth").click();
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-steps",
    "1",
  );
  await page.locator("#restart-growth").click();
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-steps",
    "0",
  );
});

test("pointer disturbance uses the displayed field's bottom-up coordinates", async ({
  page,
}) => {
  await selectGrowth(page);
  await page.evaluate(() => {
    const runtime = window.__growthRuntime;
    runtime.step(2);
    const disturb = runtime.disturb.bind(runtime);
    runtime.disturb = (...args) => {
      window.__lastDisturbance = args;
      return disturb(...args);
    };
  });
  const canvas = page.locator("#output-canvas");
  await canvas.scrollIntoViewIfNeeded();
  const rect = await canvas.boundingBox();
  const side = Math.min(rect.width, rect.height);
  await page.mouse.click(
    rect.x + rect.width / 2,
    rect.y + (rect.height - side) / 2 + side * 0.25,
  );
  await expect
    .poll(() => page.evaluate(() => window.__lastDisturbance))
    .toEqual([128, 192, 16]);
  await page.evaluate(async () => {
    const { NeuralGrowthModel } =
      await import("/assets/js/models/neural-growth.js");
    Object.defineProperty(NeuralGrowthModel.prototype, "effectivePan", {
      get: () => [0.2, -0.1],
    });
  });
  await page.getByLabel("ZOOM", { exact: true }).selectOption("2");
  await canvas.scrollIntoViewIfNeeded();
  const zoomedRect = await canvas.boundingBox();
  const zoomedSide = Math.min(zoomedRect.width, zoomedRect.height);
  await page.mouse.click(
    zoomedRect.x + zoomedRect.width / 2,
    zoomedRect.y + (zoomedRect.height - zoomedSide) / 2 + zoomedSide * 0.25,
  );
  await expect
    .poll(() => page.evaluate(() => window.__lastDisturbance))
    .toEqual([179, 134, 16]);
  await page.evaluate(async () => {
    const { NeuralGrowthModel } =
      await import("/assets/js/models/neural-growth.js");
    Object.defineProperty(NeuralGrowthModel.prototype, "effectivePan", {
      get: () => [0.5, 0],
    });
    window.__seamDisturbances = [];
    const runtime = window.__growthRuntime;
    const disturb = runtime.disturb;
    runtime.disturb = function (...args) {
      window.__seamDisturbances.push(args);
      return disturb.apply(this, args);
    };
  });
  await page.getByLabel("ZOOM", { exact: true }).selectOption("4");
  await canvas.scrollIntoViewIfNeeded();
  const seamRect = await canvas.boundingBox();
  const seamSide = Math.min(seamRect.width, seamRect.height);
  const centerX = seamRect.x + seamRect.width / 2;
  const centerY = seamRect.y + seamRect.height / 2;
  await page.mouse.move(centerX - seamSide * 0.01, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + seamSide * 0.01, centerY);
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.__seamDisturbances.length))
    .toBeGreaterThan(1);
  expect(
    await page.evaluate(() =>
      window.__seamDisturbances.every(([x]) => x < 4 || x > 252),
    ),
  ).toBe(true);
  expect((await state(page)).steps).toBe(2);
});

test("barrier outlines and ripple displacement wrap with the displayed torus", async ({
  page,
}) => {
  await selectGrowth(page);
  const result = await page.evaluate(() => {
    const runtime = window.__growthRuntime;
    runtime.disturb(2, 128, 20, "dye", { dyeColor: [1, 0, 0] });
    runtime.disturb(248, 128, 20, "freeze");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const clock = performance.now.bind(performance);
    const now = clock();
    performance.now = () => now;
    try {
      const pixels = (options) => {
        runtime.draw(canvas, options);
        return canvas.getContext("2d").getImageData(0, 0, 256, 256).data;
      };
      const same = (a, b) => a.every((value, index) => value === b[index]);
      const baseline = pixels({});
      const barrier = pixels({ showBarrier: true });
      const shiftedBarrier = pixels({ showBarrier: true, pan: [1, -1] });
      const ripples = [
        {
          x: 2,
          y: 128,
          startTime: now - 350,
          duration: 1,
          radius: 48,
          amplitude: 1.8,
        },
      ];
      const ripple = pixels({ ripples });
      const shiftedRipple = pixels({ ripples, pan: [1, -1] });
      return {
        visibleBarrier: !same(baseline, barrier),
        visibleRipple: !same(baseline, ripple),
        wrappedBarrier: same(barrier, shiftedBarrier),
        wrappedRipple: same(ripple, shiftedRipple),
        error: runtime.gl.getError(),
      };
    } finally {
      performance.now = clock;
    }
  });
  expect(result).toEqual({
    visibleBarrier: true,
    visibleRipple: true,
    wrappedBarrier: true,
    wrappedRipple: true,
    error: 0,
  });
});

test("pattern changes sync existing controls and keep modulation drawers open", async ({
  page,
}) => {
  await selectGrowth(page);
  const block = page.locator('[data-parameter="rotation"]');
  const toggle = block.locator(".modulation-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const pattern = await page.evaluate(async () => {
    window.__rotationBlock = document.querySelector(
      '[data-parameter="rotation"]',
    );
    window.__seedInput = document.querySelector('input[aria-label="SEED"]');
    const { PATTERNS } =
      await import("/assets/js/models/neural-growth/patterns.js");
    return PATTERNS.find((entry) => entry.startup?.seed > 1);
  });
  await page.getByLabel("PATTERN", { exact: true }).selectOption(pattern.id);
  await expect(page.getByLabel("SEED", { exact: true })).toHaveValue(
    String(pattern.startup.seed),
  );
  await expect(page.locator("#step-growth")).toBeEnabled();
  await page.getByLabel("PATTERN", { exact: true }).selectOption("mixed4c-439");
  await expect(page.getByLabel("SEED", { exact: true })).toHaveValue("1");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(
    await page.evaluate(
      () =>
        document.querySelector('[data-parameter="rotation"]') ===
          window.__rotationBlock &&
        document.querySelector('input[aria-label="SEED"]') ===
          window.__seedInput,
    ),
  ).toBe(true);
});

test("paused K animates ripples and live frame metrics avoid main-thread pixel readback", async ({
  page,
}) => {
  await selectGrowth(page);
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.__pixelReads = 0;
    window.__metricCaptures = 0;
    window.__rippleDraws = 0;
    const read = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      window.__pixelReads++;
      return read.apply(this, args);
    };
    const capture = window.createImageBitmap;
    window.createImageBitmap = function (...args) {
      if (args[1]?.resizeWidth === 96) window.__metricCaptures++;
      return capture.apply(this, args);
    };
    const runtime = window.__growthRuntime;
    const draw = runtime.draw;
    runtime.draw = function (...args) {
      window.__rippleDraws++;
      return draw.apply(this, args);
    };
  });
  await page.keyboard.press("k");
  await expect
    .poll(() => page.evaluate(() => window.__rippleDraws))
    .toBeGreaterThan(1);
  await expect(page.locator("#toggle-animation")).toHaveText("CLOCK: OFF");
  await page.locator("#toggle-animation").click();
  await expect
    .poll(() => page.evaluate(() => window.__metricCaptures))
    .toBeGreaterThan(1);
  expect(await page.evaluate(() => window.__pixelReads)).toBe(0);
});

test("continuous pointer dragging during live growth does not interrupt or reset steps", async ({
  page,
}) => {
  await selectGrowth(page);
  await page.locator("#toggle-animation").click();
  await expect.poll(async () => (await state(page)).steps).toBeGreaterThan(2);

  const canvas = page.locator("#output-canvas");
  await canvas.scrollIntoViewIfNeeded();
  const rect = await canvas.boundingBox();
  const side = Math.min(rect.width, rect.height);
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const startX = centerX - side * 0.25;
  const startY = centerY - side * 0.25;
  const endX = centerX + side * 0.25;
  const endY = centerY + side * 0.25;

  const stepsBefore = (await state(page)).steps;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(
      startX + (endX - startX) * (i / 5),
      startY + (endY - startY) * (i / 5),
    );
    await page.waitForTimeout(50);
  }
  await page.mouse.up();

  const stepsAfter = (await state(page)).steps;
  expect(stepsAfter).toBeGreaterThan(stepsBefore);
  await expect(page.locator("#toggle-animation")).toHaveText("CLOCK: ON");
});

test("drawing while paused modifies the field without advancing simulation steps or starting clock", async ({
  page,
}) => {
  await selectGrowth(page);
  await page.locator("#step-growth").click();
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-steps",
    "1",
  );
  await expect(page.locator("#toggle-animation")).toHaveText("CLOCK: OFF");
  const before = await state(page);

  const canvas = page.locator("#output-canvas");
  await canvas.scrollIntoViewIfNeeded();
  const rect = await canvas.boundingBox();
  const side = Math.min(rect.width, rect.height);
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  await page.mouse.move(centerX - side * 0.2, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + side * 0.2, centerY);
  await page.mouse.up();

  await expect.poll(async () => (await state(page)).hash).not.toBe(before.hash);

  const after = await state(page);
  expect(after.steps).toBe(before.steps);
  await expect(page.locator("#toggle-animation")).toHaveText("CLOCK: OFF");
});

test("failed checkpoint loading latches once and Restart retries cleanly", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/models/neural-growth/checkpoint.json", async (route) => {
    requests += 1;
    if (requests === 1)
      await route.fulfill({ status: 503, body: "Unavailable" });
    else await route.continue();
  });
  await page.locator("#model-select").selectOption("neural-growth");
  await expect(page.locator("#growth-status")).toContainText(
    "Checkpoint request failed (503)",
  );
  await page.locator('[data-section="display"] > summary').click();
  await page
    .getByLabel("DISPLAY PALETTE", { exact: true })
    .selectOption("spectral");
  await page.waitForTimeout(100);
  expect(requests).toBe(1);
  await page.locator("#restart-growth").click();
  await expect(page.locator("#step-growth")).toBeEnabled();
  expect(requests).toBe(2);
});

test("original pattern selection loads once and refreshes committed attribution", async ({
  page,
}) => {
  let requests = 0;
  await page.route(
    "**/organic-structures/membrane-field.json",
    async (route) => {
      requests += 1;
      await route.continue();
    },
  );
  await selectGrowth(page);
  expect(requests).toBe(0);
  await page.locator("#step-growth").click();
  await page.evaluate(() => {
    window.__referenceRuntime = window.__growthRuntime;
  });
  const pattern = page.getByLabel("PATTERN", { exact: true });
  await pattern.selectOption("membrane-field");
  await expect
    .poll(() => page.evaluate(() => window.__growthRuntime.model.id))
    .toBe("membrane-field");
  await expect(page.locator("#model-info-content")).toContainText(
    "Organic Structures",
  );
  await expect(page.locator("#model-info-content")).toContainText(
    "training from scratch",
  );
  expect(
    await page.evaluate(() => window.__referenceRuntime.getStats().disposed),
  ).toBe(true);
  await page.locator("#step-growth").click();
  const before = await state(page);
  await page
    .getByLabel("DISPLAY PALETTE", { exact: true })
    .selectOption("spectral");
  expect(await state(page)).toEqual(before);
  expect(requests).toBe(1);
  await pattern.selectOption("mixed4c-439");
  await expect(page.locator("#model-info-content")).toContainText("CC-BY-4.0");
  await pattern.selectOption("membrane-field");
  await expect(page.locator("#model-info-content")).toContainText(
    "Organic Structures",
  );
  expect(requests).toBe(1);
  await pattern.selectOption("mixed4a-391-v09");
  await expect
    .poll(() => page.evaluate(() => window.__growthRuntime?.model?.id))
    .toBe("mixed4a-391-v09");
  await expect(page.locator("#model-info-content")).toContainText("mixed4a");
});

test("a failed replacement preserves the current pattern without retry loops", async ({
  page,
}) => {
  let requests = 0;
  await page.route(
    "**/organic-structures/membrane-field.json",
    async (route) => {
      requests += 1;
      if (requests === 1)
        await route.fulfill({ status: 503, body: "Unavailable" });
      else await route.continue();
    },
  );
  await selectGrowth(page);
  await page.locator("#step-growth").click();
  const before = await state(page);
  const pattern = page.getByLabel("PATTERN", { exact: true });
  await pattern.selectOption("membrane-field");
  await expect(page.locator("#growth-status")).toContainText("503");
  expect(await state(page)).toEqual(before);
  await expect(page.locator("#model-info-content")).toContainText(
    "Vesicle Study",
  );
  await page
    .getByLabel("DISPLAY PALETTE", { exact: true })
    .selectOption("spectral");
  expect(await state(page)).toEqual(before);
  expect(requests).toBe(1);
  await pattern.selectOption("mixed4c-439");
  await expect(page.locator("#step-growth")).toBeEnabled();
  expect(await state(page)).toEqual(before);
  await pattern.selectOption("membrane-field");
  await expect(page.locator("#step-growth")).toBeEnabled();
  await expect(page.locator("#model-info-content")).toContainText(
    "Organic Structures",
  );
  expect(requests).toBe(2);
});

test("an obsolete pattern download cannot replace the field after selection changes", async ({
  page,
}) => {
  let entered;
  let release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/organic-structures/membrane-field.json",
    async (route) => {
      entered();
      await waiting;
      await route.continue().catch(() => {});
    },
  );
  await selectGrowth(page);
  await page.locator("#step-growth").click();
  const before = await state(page);
  const pattern = page.getByLabel("PATTERN", { exact: true });
  await pattern.selectOption("membrane-field");
  await started;
  await pattern.selectOption("mixed4c-439");
  release();
  await expect(page.locator("#step-growth")).toBeEnabled();
  await expect(page.locator("#model-info-content")).toContainText(
    "Vesicle Study",
  );
  expect(await state(page)).toEqual(before);
  expect(await page.evaluate(() => window.__growthRuntime.model.id)).toBe(
    "mixed4c-439",
  );
});

test("all original checkpoints grow in the app, fit narrow layouts, and snapshot without advancing", async ({
  page,
}) => {
  await selectGrowth(page);
  const pattern = page.getByLabel("PATTERN", { exact: true });
  for (const id of ["membrane-field", "filament-network", "xeno-reef"]) {
    await pattern.selectOption(id);
    await expect
      .poll(() => page.evaluate(() => window.__growthRuntime.model.id))
      .toBe(id);
    await page.evaluate(() => window.__growthRuntime.step(64));
    await page
      .getByLabel("DISPLAY PALETTE", { exact: true })
      .selectOption("native");
    await expect(page.locator("#growth-status")).toHaveAttribute(
      "data-steps",
      "64",
    );
    const spread = await page.evaluate(() => {
      const bytes = window.__growthRuntime.readState();
      let min = 255;
      let max = 0;
      for (let index = 0; index < bytes.length; index += 12) {
        min = Math.min(min, bytes[index]);
        max = Math.max(max, bytes[index]);
      }
      return max - min;
    });
    expect(spread).toBeGreaterThan(16);
  }
  for (const width of [360, 900]) {
    await page.setViewportSize({ width, height: 900 });
    await pattern.scrollIntoViewIfNeeded();
    await expect(pattern).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  const before = await state(page);
  await page.locator("#save-image").click();
  const download = page.waitForEvent("download");
  await page.locator("#export-modal-confirm").click();
  await download;
  expect(await state(page)).toEqual(before);
});

test("pattern gallery opens, filters by tab, searches, bookmarks favorites, and switches models", async ({
  page,
}) => {
  // Software WebGL can block the page while compiling a replacement runtime.
  test.setTimeout(120_000);
  await selectGrowth(page);
  const galleryBtn = page.locator("#open-growth-gallery");
  await expect(galleryBtn).toBeVisible();
  await galleryBtn.click();

  const dialog = page.locator("#growth-gallery-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.locator("#growth-gallery-count")).toContainText("161");

  // Testing models show their bundled previews and load from gallery selection.
  await page.locator(".growth-gallery__tab[data-filter='testing']").click();
  await expect(page.locator("#growth-gallery-count")).toHaveText("54 patterns");
  const testingCard = page.locator(
    '.growth-gallery__card[data-pattern-id="mixed4a-391-guidance-r02-s02"]',
  );
  await expect(testingCard.locator(".growth-gallery__card-badge")).toHaveText(
    "Testing / WIP",
  );
  await expect
    .poll(() =>
      testingCard
        .locator("img")
        .evaluate((img) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);
  await testingCard.click();
  await expect(dialog).not.toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__growthRuntime.model.id), {
      timeout: 45_000,
    })
    .toBe("mixed4a-391-guidance-r02-s02");
  await galleryBtn.click();

  // Filter tab: Textures (39)
  await page.locator(".growth-gallery__tab[data-filter='texture']").click();
  await expect(page.locator("#growth-gallery-count")).toContainText("39");

  // Search filter
  const searchInput = page.locator("#growth-gallery-search");
  await searchInput.fill("bubbly");
  await expect(page.locator("#growth-gallery-count")).toContainText("2");

  // Favorite bookmarking
  const favBtn = page.locator(".growth-gallery__fav-btn").first();
  await favBtn.click();
  await expect(favBtn).toHaveClass(/is-fav/);
  await expect(page.locator("#growth-favorites-count")).toHaveText("1");

  // Filter tab: Favorites (1)
  await searchInput.fill("");
  await page.locator(".growth-gallery__tab[data-filter='favorites']").click();
  await expect(page.locator("#growth-gallery-count")).toContainText("1");

  // Filter tab: Originals (25) and check citation info overlay
  await page.locator(".growth-gallery__tab[data-filter='organic']").click();
  await expect(page.locator("#growth-gallery-count")).toContainText("25");

  const organicCard = dialog.locator(".growth-gallery__card").first();
  const cardSubId = await organicCard
    .locator(".growth-gallery__card-id")
    .textContent();
  expect(cardSubId).not.toContain("glitch/");
  expect(cardSubId).not.toContain("overnight/");

  const infoBtn = organicCard.locator(".growth-gallery__info-btn");
  await expect(infoBtn).toBeVisible();
  await infoBtn.click();
  const infoOverlay = organicCard.locator(".growth-gallery__info-overlay");
  await expect(infoOverlay).toBeVisible();
  await expect(infoOverlay).toContainText("Source Imagery");
  await organicCard.locator(".growth-gallery__info-overlay-close").click();
  await expect(infoOverlay).not.toBeVisible();

  // Switch back to favorites tab to select the bookmarked card
  await page.locator(".growth-gallery__tab[data-filter='favorites']").click();

  // Select pattern from gallery
  const card = dialog.locator(".growth-gallery__card").first();
  await card.click();
  await expect(dialog).not.toBeVisible();

  // Selected pattern should now be loaded
  await expect
    .poll(() => page.evaluate(() => window.__growthRuntime.model.id), {
      timeout: 45_000,
    })
    .toBe("bubbly-0101");
});

test("continuous rotation and growth speed expose modulation controls with circular wrapping", async ({
  page,
}) => {
  await selectGrowth(page);
  // Ensure rotation has MOD button and circular wrap works
  const rotationMod = page.locator(
    'button.modulation-toggle[data-key="rotation"]',
  );
  await expect(rotationMod).toBeVisible();

  const twistMod = page.locator('button.modulation-toggle[data-key="twist"]');
  await expect(twistMod).toBeVisible();

  const speedMod = page.locator(
    'button.modulation-toggle[data-key="growthSpeed"]',
  );
  await expect(speedMod).toBeVisible();

  // Test circular wrap on rotation
  const wrapped = await page.evaluate(async () => {
    const { coerceRangeValue } =
      await import("/assets/js/app/controls-controller.js");
    const def = { min: 0, max: 360, step: 1, wrap: true };
    return [
      coerceRangeValue(def, 375),
      coerceRangeValue(def, -15),
      coerceRangeValue(def, 720),
    ];
  });
  expect(wrapped).toEqual([15, 345, 0]);
});

test("coordinate geometry selector switches modes, updates smart pitch defaults, and steps WebGL cleanly", async ({
  page,
}) => {
  await selectGrowth(page);

  // Check controls exist
  const geometrySelect = page.getByLabel("COORDINATE GEOMETRY", {
    exact: true,
  });
  await expect(geometrySelect).toBeVisible();
  await expect(geometrySelect).toHaveValue("cartesian");

  const twistInput = page.getByLabel("SPIRAL PITCH / TWIST", { exact: true });
  await expect(twistInput).toBeVisible();
  await expect(twistInput).toHaveValue("0");

  const twistMod = page.locator('button.modulation-toggle[data-key="twist"]');
  await expect(twistMod).toBeVisible();

  // Switch to spiral: should apply smart default 35 deg pitch
  await geometrySelect.selectOption("spiral");
  await expect(twistInput).toHaveValue("35");

  // Step growth in spiral mode
  await page.locator("#step-growth").click();
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-steps",
    "1",
  );

  // Switch to julia fractal
  await geometrySelect.selectOption("julia");
  await expect(twistInput).toHaveValue("0");

  // Step in julia mode
  await page.locator("#step-growth").click();
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-steps",
    "2",
  );

  // Switch to dipole
  await geometrySelect.selectOption("dipole");
  await page.locator("#step-growth").click();
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-steps",
    "3",
  );

  // Switch to vortex
  await geometrySelect.selectOption("vortex");
  await page.locator("#step-growth").click();
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-steps",
    "4",
  );

  // Switch to wave
  await geometrySelect.selectOption("wave");
  await page.locator("#step-growth").click();
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-steps",
    "5",
  );

  // Switch to saddle
  await geometrySelect.selectOption("saddle");
  await page.locator("#step-growth").click();
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-steps",
    "6",
  );

  // Switch to kaleidoscope
  await geometrySelect.selectOption("kaleidoscope");
  await page.locator("#step-growth").click();
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-steps",
    "7",
  );

  // Switch to vortex pair
  await geometrySelect.selectOption("vortex_pair");
  await page.locator("#step-growth").click();
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-steps",
    "8",
  );

  // Switch to voronoi
  await geometrySelect.selectOption("voronoi");
  await page.locator("#step-growth").click();
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-steps",
    "9",
  );

  // Context is healthy with 0 errors
  expect(
    await page.evaluate(() => window.__growthRuntime.getStats().contextLost),
  ).toBe(false);
});

test("interactive brushes support top toolbar, color presets, ripple, freeze/thaw and flow grooming", async ({
  page,
}) => {
  await selectGrowth(page);

  // Check top canvas toolbar is visible
  const canvasToolbar = page.locator("#growth-canvas-tools");
  await expect(canvasToolbar).toBeVisible();

  // Click COLOR brush in top toolbar
  const colorBtn = page.locator('.growth-brush-btn[data-brush="dye"]');
  await expect(colorBtn).toBeVisible();
  await colorBtn.click();
  await expect(colorBtn).toHaveClass(/is-active/);

  // Check color options row is visible in canvas toolbar
  const colorOptions = page.locator("#growth-color-options");
  await expect(colorOptions).toBeVisible();

  // Click Magenta preset pill in canvas toolbar
  const magentaPill = colorOptions.locator(
    ".color-preset-pill[data-color='#ff00a0']",
  );
  await expect(magentaPill).toBeVisible();
  await magentaPill.click();

  const colorPicker = page.locator("#growth-color-picker");
  await expect(colorPicker).toHaveValue("#ff00a0");
  const hexInput = page.locator("#growth-color-hex");
  await expect(hexInput).toHaveValue("#FF00A0");

  // Perform pointer disturbance in color mode
  const canvas = page.locator("#output-canvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // Switch to ripple and click
  const rippleBtn = page.locator('.growth-brush-btn[data-brush="shockwave"]');
  await rippleBtn.click();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // Switch to freeze and click/drag
  const freezeBtn = page.locator('.growth-brush-btn[data-brush="freeze"]');
  await freezeBtn.click();
  const freezeOptions = page.locator("#growth-freeze-options");
  await expect(freezeOptions).toBeVisible();

  // Test freeze lock mode toggle (MASK vs DRAW)
  const maskBtn = page.locator("#growth-freeze-lock-mask");
  const drawBtn = page.locator("#growth-freeze-lock-draw");
  await expect(maskBtn).toBeVisible();
  await expect(drawBtn).toBeVisible();
  await expect(maskBtn).toHaveClass(/is-active/);
  await drawBtn.click();
  await expect(drawBtn).toHaveClass(/is-active/);
  await expect(maskBtn).not.toHaveClass(/is-active/);
  await maskBtn.click();
  await expect(maskBtn).toHaveClass(/is-active/);

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // Test clear barrier button is accessible across modes
  const clearBarrierBtn = page.locator("#growth-clear-barrier-btn");
  await expect(clearBarrierBtn).toBeVisible();
  await clearBarrierBtn.click();

  // Switch to unfreeze and click
  const thawBtn = page.locator('.growth-brush-btn[data-brush="thaw"]');
  await thawBtn.click();
  await expect(clearBarrierBtn).toBeVisible();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // Switch to flow and drag stroke
  const flowBtn = page.locator('.growth-brush-btn[data-brush="groom"]');
  await flowBtn.click();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 20);
  await page.mouse.up();

  // Test C key shortcut clearing barriers when canvas is focused
  await freezeBtn.click();
  await page.mouse.click(box.x + 40, box.y + 40);
  await page.keyboard.press("c");
  await expect(clearBarrierBtn).toBeVisible();

  // Test clicking outside unfocuses canvas for C key
  const brand = page.locator("#brand-home");
  await brand.click();
  await page.keyboard.press("c");

  expect(
    await page.evaluate(() => window.__growthRuntime.getStats().contextLost),
  ).toBe(false);
});

test("paused audio controls leave manual Full/Kick routes and LFOs available", async ({
  page,
}) => {
  await selectGrowth(page);
  for (const key of [
    "audioProfile",
    "beatShockwave",
    "shockwaveIntensity",
    "acousticInjection",
    "acousticThreshold",
    "acousticPosition",
    "cameraBreathing",
    "cameraReactivity",
  ]) {
    await expect(page.locator(`[data-parameter="${key}"]`)).toHaveCount(0);
  }
  const control = page.locator('[data-parameter="rotation"]');
  await control.locator(".modulation-toggle").click();
  const drawer = control.locator(".modulation-drawer");
  await drawer.getByRole("button", { name: "Full", exact: true }).click();
  await expect(drawer.locator(".drawer-audio")).toHaveAttribute(
    "data-source",
    "bass",
  );
  await drawer.getByRole("button", { name: "Kick", exact: true }).click();
  await drawer.locator('[data-field="audioDepth"]').fill("0.3");
  await drawer.locator('[data-field="enabled"]').check();
  await expect(page.locator("#toggle-animation")).toHaveText("CLOCK: ON");
  await page.locator("#toggle-animation").click();
  await page.locator("#run-experiment").click();
  await expect(page.locator("#status-message")).toHaveText("Frame saved");
  const record = await page.evaluate(
    () => JSON.parse(localStorage.getItem("latent-field-saved-runs-v1"))[0],
  );
  expect(record.audioModulation.rotation).toMatchObject({
    source: "kick",
    depth: 0.3,
  });
  expect(record.modulation.rotation.enabled).toBe(true);
  expect(record.parameters.audioProfile).toBe("off");
  await expect(page.locator("#toggle-audio-input")).toBeEnabled();
  await expect(page.locator("#audio-meter")).toBeVisible();
});

test("channel inspector exposes hidden channel modes and preserves simulation state", async ({
  page,
}) => {
  await selectGrowth(page);

  const channelSelect = page.getByLabel("CHANNEL INSPECTOR", { exact: true });
  await expect(channelSelect).toBeVisible();
  await expect(channelSelect).toHaveValue("phenotype");

  // Step simulation once
  await page.locator("#step-growth").click();

  // Switch to Vitality
  await channelSelect.selectOption("vitality");
  await expect(channelSelect).toHaveValue("vitality");

  // Switch to Fast Signals
  await channelSelect.selectOption("fast_signals");
  await expect(channelSelect).toHaveValue("fast_signals");

  // Switch to Energy Heatmap
  await channelSelect.selectOption("energy_heat");
  await expect(channelSelect).toHaveValue("energy_heat");

  // Switch to Neural X-Ray
  await channelSelect.selectOption("xray");
  await expect(channelSelect).toHaveValue("xray");

  // Return to phenotype
  await channelSelect.selectOption("phenotype");
  await expect(channelSelect).toHaveValue("phenotype");
});

test("display filter switches between Smooth Continuous and Crisp Pixel Grid cleanly", async ({
  page,
}) => {
  await selectGrowth(page);

  const filterSelect = page.getByLabel("DISPLAY FILTER", { exact: true });
  await expect(filterSelect).toBeVisible();
  await expect(filterSelect).toHaveValue("smooth");

  // Step simulation once
  await page.locator("#step-growth").click();

  // Switch to Crisp
  await filterSelect.selectOption("crisp");
  await expect(filterSelect).toHaveValue("crisp");

  // Return to Smooth
  await filterSelect.selectOption("smooth");
  await expect(filterSelect).toHaveValue("smooth");

  // Context remains healthy with 0 errors
  expect(
    await page.evaluate(() => window.__growthRuntime.getStats().contextLost),
  ).toBe(false);
});

test("contextual guidance pills render beneath key controls and tap recovery sprouts dormant fields", async ({
  page,
}) => {
  await selectGrowth(page);

  // 1. Verify guidance pill under Growth Speed
  const speedBlock = page.locator(".control-block", {
    has: page.getByLabel("GROWTH SPEED", { exact: true }),
  });
  const speedGuidance = speedBlock.locator(".control-guidance");
  await expect(speedGuidance).toBeVisible();
  await expect(speedGuidance.locator(".control-guidance__tag")).toHaveText(
    "RECOMMENDED",
  );

  // 2. Verify twist guidance is INACTIVE while in Cartesian mode
  const twistBlock = page.locator(".control-block", {
    has: page.getByLabel("SPIRAL PITCH / TWIST", { exact: true }),
  });
  const twistGuidance = twistBlock.locator(".control-guidance");
  await expect(twistGuidance).toBeVisible();
  await expect(twistGuidance.locator(".control-guidance__tag")).toHaveText(
    "INACTIVE",
  );

  // 3. Switch coordinate geometry to Spiral
  const geometrySelect = page.getByLabel("COORDINATE GEOMETRY", {
    exact: true,
  });
  await geometrySelect.selectOption("spiral");

  // In Spiral mode: twist guidance updates reactively
  await expect(twistGuidance.locator(".control-guidance__tag")).not.toHaveText(
    "INACTIVE",
  );

  // 4. Disturbance mode guidance
  await page.locator("#brush-settings > summary").click();
  const modeSelect = page.getByLabel("Brush mode", { exact: true });
  await modeSelect.selectOption("noise");
  await expect(page.locator('[data-brush="noise"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // 5. Channel inspector guidance
  const channelSelect = page.getByLabel("CHANNEL INSPECTOR", { exact: true });
  await channelSelect.selectOption("fast_signals");
  const channelBlock = page.locator(".control-block", { has: channelSelect });
  await expect(channelBlock.locator(".control-guidance__tag")).toHaveText(
    "CH 4-6",
  );

  // Return to Phenotype
  await channelSelect.selectOption("phenotype");
  await expect(channelBlock.locator(".control-guidance__tag")).toHaveText(
    "RECOMMENDED",
  );

  // 6. Dormant tap recovery:
  // Step simulation, clear field with erase, verify dormant tap recovery
  await modeSelect.selectOption("erase");
  // Drag erase over center
  const canvas = page.locator("#output-canvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Switch to ripple/shockwave
  await modeSelect.selectOption("shockwave");
  // Tap center on quiet/running field
  await page.mouse.click(cx, cy);

  // Runtime remains healthy and active
  expect(
    await page.evaluate(() => window.__growthRuntime.getStats().contextLost),
  ).toBe(false);
});

test("Shift+Click on canvas repositions geometry center and Shift+dblclick resets", async ({
  page,
}) => {
  await selectGrowth(page);
  const canvas = page.locator("#output-canvas");
  await canvas.scrollIntoViewIfNeeded();
  const rect = await canvas.boundingBox();
  const side = Math.min(rect.width, rect.height);

  // Shift+Click at 75% horizontal, 25% vertical
  await page.keyboard.down("Shift");
  await page.mouse.click(
    rect.x + (rect.width - side) / 2 + side * 0.75,
    rect.y + (rect.height - side) / 2 + side * 0.25,
  );
  await page.keyboard.up("Shift");

  // Center X should be approx +0.5, Center Y should be approx +0.5 (bottom-up: 1 - 0.25 = 0.75 -> (0.75 - 0.5) * 2 = 0.5)
  const centerXInput = page.getByLabel("CENTER X", { exact: true });
  const centerYInput = page.getByLabel("CENTER Y", { exact: true });
  await expect
    .poll(async () => Number(await centerXInput.inputValue()))
    .toBeCloseTo(0.5, 1);
  await expect
    .poll(async () => Number(await centerYInput.inputValue()))
    .toBeCloseTo(0.5, 1);

  // Shift+dblclick resets center to 0, 0
  await page.keyboard.down("Shift");
  await page.mouse.dblclick(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.keyboard.up("Shift");
  await expect
    .poll(async () => Number(await centerXInput.inputValue()))
    .toBe(0);
  await expect
    .poll(async () => Number(await centerYInput.inputValue()))
    .toBe(0);
});

test("temporal echoes configure decay, drift and flow dynamics cleanly", async ({
  page,
}) => {
  await selectGrowth(page);

  const decayInput = page.getByLabel("TEMPORAL ECHO DECAY exact value", {
    exact: true,
  });
  await expect(decayInput).toBeVisible();
  await decayInput.fill("70");

  const driftInput = page.getByLabel("TEMPORAL ECHO DRIFT exact value", {
    exact: true,
  });
  await expect(driftInput).toBeVisible();
  await driftInput.fill("0.5");

  const modeSelect = page.getByLabel("ECHO FLOW DYNAMICS", { exact: true });
  await modeSelect.selectOption("radial_bloom");

  const styleSelect = page.getByLabel("ECHO BLEND STYLE", { exact: true });
  await styleSelect.selectOption("mist");

  await page.locator("#step-growth").click();
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-steps",
    "1",
  );

  // WebGL context is healthy with zero loss
  expect(
    await page.evaluate(() => window.__growthRuntime.getStats().contextLost),
  ).toBe(false);

  // Restore to 0 decay
  await decayInput.fill("0");
  await page.locator("#step-growth").click();
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-steps",
    "2",
  );
  expect(
    await page.evaluate(() => window.__growthRuntime.getStats().contextLost),
  ).toBe(false);
});

test("visualizer settings hide disabled coupling while keeping the display controls", async ({
  page,
}) => {
  await selectGrowth(page);
  await page.locator("#open-visualizer-settings").click();
  await expect(page.locator("#visualizer-injection-select")).toBeHidden();
  await expect(page.locator("#visualizer-injection-select")).toBeDisabled();
  await expect(page.locator("#visualizer-mode-select")).toBeVisible();
  await expect(page.locator("#visualizer-style-select")).toBeVisible();
  await page.locator("#close-visualizer-settings").click();
});

test("restoring old audio settings preserves values and manual routes without preset overrides", async ({
  page,
}) => {
  await selectGrowth(page);
  await page.evaluate(async () => {
    const { NeuralGrowthModel } =
      await import("/assets/js/models/neural-growth.js");
    const render = NeuralGrowthModel.prototype.render;
    NeuralGrowthModel.prototype.render = function (
      canvas,
      parameters,
      ...args
    ) {
      window.__effectiveGrowthParameters = { ...parameters };
      window.__growthModel = this;
      return render.call(this, canvas, parameters, ...args);
    };
    const { TextureNcaRuntime } =
      await import("/assets/js/models/neural-growth/runtime.js");
    const draw = TextureNcaRuntime.prototype.draw;
    TextureNcaRuntime.prototype.draw = function (canvas, options) {
      window.__growthDrawOptions = options;
      return draw.call(this, canvas, options);
    };
  });
  await page.locator("#run-experiment").click();
  await expect(page.locator("#status-message")).toHaveText("Frame saved");
  await page.evaluate(() => {
    const key = "latent-field-saved-runs-v1";
    const records = JSON.parse(localStorage.getItem(key));
    Object.assign(records[0].parameters, {
      audioProfile: "dynamic",
      beatShockwave: "on",
      shockwaveIntensity: 0.7,
      acousticInjection: "dye",
      cameraBreathing: "punchy",
      cameraReactivity: 0.8,
      growthSpeed: 7,
      zoom: 2,
    });
    records[0].audioModulation.rotation = { source: "kick", depth: 0.3 };
    records[0].modulation.rotation = {
      enabled: true,
      waveform: "sine",
      rate: 0.01,
      depth: 0.1,
      phase: 0,
      polarity: "positive",
    };
    localStorage.setItem(key, JSON.stringify(records));
  });
  await page.locator('[data-view="saved"]').click();
  await page
    .locator(".run-card")
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__effectiveGrowthParameters?.growthSpeed),
    )
    .toBe(7);
  await expect
    .poll(() => page.evaluate(() => window.__growthDrawOptions?.zoom))
    .toBe(2);
  const stored = await page.evaluate(() => window.__growthModel.parameters);
  expect(stored).toMatchObject({
    audioProfile: "dynamic",
    beatShockwave: "on",
    shockwaveIntensity: 0.7,
    acousticInjection: "dye",
    cameraBreathing: "punchy",
    cameraReactivity: 0.8,
  });
  const control = page.locator('[data-parameter="rotation"]');
  await control.locator(".modulation-toggle").click();
  await expect(control.locator(".drawer-audio")).toHaveAttribute(
    "data-source",
    "kick",
  );
  await expect(control.locator('[data-field="enabled"]')).toBeChecked();
  await expect(control.locator('[data-field="audioDepth"]')).toHaveValue("0.3");
  await page.locator("#toggle-animation").click();
  await page.locator("#run-experiment").click();
  await expect(page.locator("#status-message")).toHaveText("Frame saved");
  const resaved = await page.evaluate(
    () => JSON.parse(localStorage.getItem("latent-field-saved-runs-v1"))[0],
  );
  expect(resaved.parameters).toMatchObject({
    audioProfile: "dynamic",
    acousticInjection: "dye",
    cameraBreathing: "punchy",
  });
  expect(resaved.audioModulation.rotation).toMatchObject({
    source: "kick",
    depth: 0.3,
  });
});

test("pure NCA controls run without loading Inception guidance or sensor resources", async ({
  page,
}) => {
  const inferenceRequests = [];
  page.on("request", (request) => {
    if (
      /models\/inception\/|inception-sensor|tensorflow.*\.js|tf\.min\.js/.test(
        request.url(),
      )
    )
      inferenceRequests.push(request.url());
  });
  await selectGrowth(page);
  for (const key of [
    "dreamEnabled",
    "dreamStrength",
    "dreamCadence",
    "targetLayer",
    "targetChannel",
    "dreamChroma",
  ]) {
    await expect(page.locator(`[data-parameter="${key}"]`)).toHaveCount(0);
  }
  await expect(page.locator('[data-section="dream"]')).toHaveCount(0);
  await expect(page.locator(".neuron-gallery")).toHaveCount(0);
  await page.locator("#step-growth").click();
  expect((await state(page)).steps).toBeGreaterThan(0);
  await expect(page.locator('[data-source="inception"]')).toHaveCount(0);
  expect(inferenceRequests).toEqual([]);
});
