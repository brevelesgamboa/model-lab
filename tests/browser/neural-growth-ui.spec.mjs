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

async function observeVitalityModel(page) {
  await page.evaluate(async () => {
    const { NeuralGrowthModel } = await import("/assets/js/models/neural-growth.js");
    const original = NeuralGrowthModel.prototype.render;
    NeuralGrowthModel.prototype.render = async function (...args) {
      const result = await original.apply(this, args);
      window.__vitalityModel = this;
      window.__growthRuntime = this._runtime;
      return result;
    };
  });
}

test("vitality HUD is opt-in, ignores typing focus, and is scoped to the Growth lab route", async ({ page }) => {
  await selectGrowth(page);
  const hud = page.locator("#growth-vitality-diagnostics");
  await expect(hud).toBeHidden();
  await page.getByLabel("GROWTH SPEED exact value", { exact: true }).focus();
  await page.keyboard.press("d");
  await expect(hud).toBeHidden();
  await page.getByLabel("COORDINATE GEOMETRY", { exact: true }).focus();
  await page.keyboard.press("d");
  await expect(hud).toBeHidden();
  // Exercise textarea and contenteditable guards without changing application UI.
  for (const tag of ["textarea", "div"]) {
    await page.evaluate((tag) => {
      const node = document.createElement(tag); node.id = "typing-guard";
      if (tag === "div") node.contentEditable = "true";
      document.body.append(node); node.focus();
    }, tag);
    await page.keyboard.press("d");
    await expect(hud).toBeHidden();
    await page.locator("#typing-guard").evaluate((node) => node.remove());
  }
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("d");
  await expect(hud).toBeVisible();
  await expect(hud).toHaveAttribute("open", "");
  await page.keyboard.press("d");
  await expect(hud).toBeHidden();
  await page.keyboard.press("d");
  await hud.locator(":scope > summary").click();
  await expect(hud).not.toHaveAttribute("open");
  await hud.locator(":scope > summary").click();
  await page.locator('[data-view="saved"]').click();
  await expect(hud).toHaveAttribute("hidden", "");
  await page.locator('[data-view="lab"]').click();
  await expect(hud).toBeVisible();
  await page.locator("#model-select").selectOption("folded-fractal");
  await expect(hud).toHaveAttribute("hidden", "");
  await page.keyboard.press("d");
  await expect(hud).toBeHidden();
});

test("growthDebug URL enables HUD and Force Probe is fenced, paused and separate from evidence", async ({ page }) => {
  await page.goto("/?growthDebug=1");
  await observeVitalityModel(page);
  await selectGrowth(page);
  const hud = page.locator("#growth-vitality-diagnostics");
  await expect(hud).toBeVisible();
  const before = await page.evaluate(() => {
    const model = window.__vitalityModel, gl = model._runtime.gl;
    window.__diagnosticReads = { pbo: 0, cpu: 0 };
    const read = gl.readPixels.bind(gl);
    gl.readPixels = (...args) => {
      window.__diagnosticReads[typeof args.at(-1) === "number" ? "pbo" : "cpu"]++;
      return read(...args);
    };
    for (let i = 0; i < 50; i++) model.getVitalityDiagnostics();
    return { steps: model._runtime.steps, evidence: model._vitalityWatchdog.lastStep };
  });
  await expect.poll(() => page.evaluate(() => window.__diagnosticReads.pbo)).toBe(0);
  await hud.getByRole("button", { name: "Force Probe" }).click();
  await expect(hud.locator('[data-vitality-field="probe"]')).toContainText("forced diagnostic");
  const after = await page.evaluate(() => ({ ...window.__diagnosticReads,
    steps: window.__growthRuntime.steps, evidence: window.__vitalityModel._vitalityWatchdog.lastStep,
    action: window.__vitalityModel.getVitalityDiagnostics().actions.forceProbe.status }));
  expect(after).toEqual({ ...before, pbo: 1, cpu: 0, action: "complete" });
  await hud.getByRole("button", { name: "Test Spore" }).click();
  await expect.poll(() => page.evaluate(() => window.__vitalityModel.getVitalityDiagnostics().actions.testSpore.reason)).toBe("paused-or-stale");
  await page.locator("#toggle-animation").click();
  // On software GPUs a probe can become stale between an awaited check and a
  // click. Check freshness and dispatch the real HUD action in the same task.
  await expect.poll(() => hud.getByRole("button", { name: "Test Spore" }).evaluate((button) => {
    const model = window.__vitalityModel;
    if (model.getVitalityDiagnostics().activeBlockers.includes("paused-or-stale")) return "waiting-for-fresh-probe";
    button.click();
    return model.getVitalityDiagnostics().actions.testSpore.status;
  })).toBe("admitted");
  await expect.poll(() => page.evaluate(() => window.__vitalityModel.getVitalityDiagnostics().recovery.emittedDose)).toBeGreaterThan(0);
  await expect.poll(() => hud.getByRole("button", { name: "Test Spore" }).evaluate((button) => {
    const model = window.__vitalityModel;
    if (model.getVitalityDiagnostics().activeBlockers.includes("paused-or-stale")) return "waiting-for-fresh-probe";
    button.click();
    return model.getVitalityDiagnostics().actions.testSpore.reason;
  })).toBe("cooldown");
  await page.locator("#toggle-animation").click();
});

test("raw 12-channel atlas restores cleanly, stays outside PNG snapshots, and works fullscreen", async ({ page }) => {
  await observeVitalityModel(page);
  await selectGrowth(page);
  await page.evaluate(() => {
    const runtime = window.__growthRuntime;
    const bytes = new Uint8Array(runtime.size ** 2 * 12);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i % 12 + 1) * 17;
    runtime.writeState(bytes);
  });
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("d");
  const hud = page.locator("#growth-vitality-diagnostics");
  const raw = hud.getByRole("checkbox", { name: "Raw State View" });
  await raw.check();
  await expect.poll(() => page.evaluate(() => {
    const canvas = document.getElementById("output-canvas"), ctx = canvas.getContext("2d");
    return Array.from({ length: 12 }, (_, ch) => ctx.getImageData(
      Math.floor(((ch % 4) + .5) * canvas.width / 4),
      Math.floor((Math.floor(ch / 4) + .5) * canvas.height / 3), 1, 1).data[0]);
  })).toEqual(Array.from({ length: 12 }, (_, ch) => (ch + 1) * 17));
  const expected = await page.evaluate(() => {
    const canvas = document.createElement("canvas"), live = document.getElementById("output-canvas");
    canvas.width = live.width; canvas.height = live.height;
    window.__vitalityModel.renderSnapshot(canvas);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator("#save-image").click();
  await page.locator('input[name="export-resolution"][value="current"]').check();
  const downloaded = page.waitForEvent("download");
  await page.locator("#export-modal-confirm").click();
  const bytes = await readFile(await (await downloaded).path());
  expect(bytes.toString("base64")).toBe(expected);
  await expect(raw).toBeChecked();
  expect(await page.evaluate(() => "rawStateView" in window.__vitalityModel.parameters)).toBe(false);
  await raw.uncheck();
  await expect.poll(() => page.evaluate(() => window.__vitalityModel.getVitalityDiagnostics().display.rawStateView)).toBe(false);
  await page.locator("#toggle-fullscreen").click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe("output-panel");
  await expect(hud).toBeVisible();
  const bounds = await hud.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  await raw.check();
  await raw.evaluate((node) => node.blur());
  await page.keyboard.press("d");
  await expect(hud).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__vitalityModel.getVitalityDiagnostics().display.rawStateView)).toBe(false);
  await page.evaluate(() => document.exitFullscreen());
});

test("growth sections default to Pattern and keep brush settings in the right rail", async ({
  page,
}) => {
  await selectGrowth(page, { expandSections: false });
  await expect(page.locator(".control-section > summary")).toHaveText([
    "Pattern",
    "Geometry",
    "Temporal",
    "Display",
    "Audio",
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
    async function checkFullscreen(orientation) {
      let measured = null;
      await expect
        .poll(async () => {
          measured = await page.locator("#output-canvas").evaluate((canvas) => {
            const bounds = canvas.getBoundingClientRect();
            const runtime = window.__growthRuntime;
            return {
              width: canvas.width,
              height: canvas.height,
              runtimeWidth: runtime.canvas.width,
              runtimeHeight: runtime.canvas.height,
              boundsWidth: bounds.width,
              boundsHeight: bounds.height,
              aspectDiff: Math.abs(
                bounds.width / bounds.height - canvas.width / canvas.height,
              ),
            };
          });
          const oriented =
            orientation === "portrait"
              ? measured.height > measured.width
              : measured.width > measured.height;
          return (
            oriented &&
            measured.width === measured.runtimeWidth &&
            measured.height === measured.runtimeHeight &&
            Math.max(measured.width, measured.height) > 768 &&
            measured.width * measured.height <= 1920 * 1080 + 4096 &&
            measured.aspectDiff < 0.01
          );
        })
        .toBe(true);
      expect(measured.width * measured.height).toBeLessThan(
        Math.round(measured.boundsWidth * 2) *
          Math.round(measured.boundsHeight * 2),
      );
      return measured;
    }
    await checkFullscreen("landscape");
    // Chromium disallows native window resizing while fullscreen. Resize its
    // emulated viewport instead, which still delivers the app's resize event.
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 900,
      height: 1200,
      deviceScaleFactor: 2,
      mobile: false,
    });
    const livePortrait = await checkFullscreen("portrait");
    await page.keyboard.press("Space");
    await expect
      .poll(async () => {
        const { width, height } = await displaySize(page);
        return height > width ? width * height : 0;
      })
      .toBeGreaterThan(livePortrait.width * livePortrait.height);
    expect(await state(page)).toEqual(before);
    await page.keyboard.press("Space");
    await checkFullscreen("portrait");
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

test("retired controls are absent while normalized audio sources and LFOs remain available", async ({
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
    "audioRippleAmount",
    "audioSporeAmount",
  ]) {
    await expect(page.locator(`[data-parameter="${key}"]`)).toHaveCount(0);
  }
  const control = page.locator('[data-parameter="rotation"]');
  await control.locator(".modulation-toggle").click();
  const drawer = control.locator(".modulation-drawer");
  await drawer.locator('[data-field="audioSource"]').selectOption("audioBass");
  await expect(drawer.locator(".drawer-audio")).toHaveAttribute(
    "data-source",
    "audioBass",
  );
  await drawer.locator('[data-field="audioSource"]').selectOption("audioBeat");
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
    source: "audioBeat",
    depth: 0.3,
  });
  expect(record.modulation.rotation.enabled).toBe(true);
  expect(record.parameters).not.toHaveProperty("audioProfile");
  expect(record.parameters).not.toHaveProperty("audioSporeAmount");
  expect(record.parameters).not.toHaveProperty("audioRippleAmount");
  expect(record.parameters.audioPreset).toBe("off");
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

test("visualizer settings retain display controls with retired coupling removed", async ({
  page,
}) => {
  await selectGrowth(page);
  await page.locator("#open-visualizer-settings").click();
  await expect(page.locator("#visualizer-injection-select")).toHaveCount(0);
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
      audioPreset: "kick-spore",
      audioRippleAmount: 0.9,
      audioSporeAmount: 0.08,
      growthSpeed: 7,
      zoom: 2,
    });
    records[0].audioModulation.rotation = { source: "kick", depth: 0.3 };
    records[0].audioModulation.audioRippleAmount = {
      source: "audioBeat",
      depth: 0.9,
      owner: "preset",
    };
    records[0].audioModulation.audioSporeAmount = {
      source: "audioBody",
      depth: 0.75,
      owner: "preset",
    };
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
  for (const key of [
    "audioProfile",
    "beatShockwave",
    "shockwaveIntensity",
    "acousticInjection",
    "cameraBreathing",
    "cameraReactivity",
    "audioRippleAmount",
    "audioSporeAmount",
  ])
    expect(stored).not.toHaveProperty(key);
  expect(stored.audioPreset).toBe("off");
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
  for (const key of [
    "audioProfile",
    "acousticInjection",
    "cameraBreathing",
    "audioRippleAmount",
    "audioSporeAmount",
  ])
    expect(resaved.parameters).not.toHaveProperty(key);
  expect(resaved.audioModulation).not.toHaveProperty("audioRippleAmount");
  expect(resaved.audioModulation).not.toHaveProperty("audioSporeAmount");
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

test("audio presets preserve bases, existing LFOs, user routes and open drawers", async ({
  page,
}) => {
  await selectGrowth(page);
  const rotation = page.locator('[data-parameter="rotation"]');
  await rotation.locator(".fine-input").fill("137");
  await rotation.locator(".fine-input").dispatchEvent("change");
  await rotation.locator(".modulation-toggle").click();
  await rotation.locator('[data-field="enabled"]').check();
  await rotation.locator('[data-field="depth"]').fill("23");
  await rotation.locator('[data-field="audioSource"]').selectOption("audioAir");
  const decay = page.locator('[data-parameter="echoDecay"]');
  await decay.locator(".modulation-toggle").click();
  await decay.locator('[data-field="enabled"]').check();
  await decay.locator('[data-field="depth"]').fill("15");
  const preset = page.getByLabel("AUDIO PRESET", { exact: true });
  await expect(preset.locator("option")).toHaveCount(2);
  await expect(preset.locator("option").nth(0)).toHaveAttribute("value", "off");
  await expect(preset.locator("option").nth(1)).toHaveAttribute("value", "kick");
  await preset.selectOption("kick");
  await expect(rotation.locator(".modulation-panel")).toBeVisible();
  await expect(rotation.locator(".fine-input")).toHaveValue("137");
  await expect(rotation.locator('[data-field="enabled"]')).toBeChecked();
  await expect(rotation.locator('[data-field="depth"]')).toHaveValue("23");
  await expect(decay.locator('[data-field="audioSource"]')).toHaveValue(
    "audioBeat",
  );
  const phase = page.locator('[data-parameter="palettePhase"]');
  await phase.locator(".modulation-toggle").click();
  await expect(phase.locator('[data-field="audioSource"]')).toHaveValue(
    "audioBeat",
  );
  await phase.locator('[data-field="audioDepth"]').fill("0.3");
  await preset.selectOption("off");
  await expect(decay.locator('[data-field="enabled"]')).toBeChecked();
  await expect(decay.locator('[data-field="depth"]')).toHaveValue("15");
  const routes = await page.evaluate(async () => {
    const { audioMatrixForModel } =
      await import("/assets/js/core/modulation-matrix.js");
    return audioMatrixForModel("neural-growth");
  });
  expect(routes.rotation).toMatchObject({ source: "audioAir", owner: "user" });
  expect(routes.palettePhase).toMatchObject({
    source: "audioBeat",
    depth: 0.3,
    owner: "user",
  });
  expect(routes).not.toHaveProperty("echoDecay");
  await expect(rotation.locator(".fine-input")).toHaveValue("137");
});

test("automatic spores honor dye, toroidal feathering, RGBA8 precision and barriers", async ({
  page,
}) => {
  await selectGrowth(page);
  const result = await page.evaluate(() => {
    const runtime = window.__growthRuntime;
    const size = runtime.size,
      center = Math.floor(size / 2);
    const neutral = new Uint8Array(size * size * 12).fill(127);
    const colorAt = (state, x, y) => [
      ...state.slice((y * size + x) * 12, (y * size + x) * 12 + 3),
    ];
    runtime.writeState(neutral);
    runtime.disturb(center, center, 8, "kick_color", {
      dyeColor: [1, 0, 0],
      strength: 1,
    });
    const explicit = colorAt(runtime.readState(), center, center);
    runtime.writeState(neutral);
    runtime.disturb(center, center, 8, "kick_color", { strength: 1 });
    const implicit = colorAt(runtime.readState(), center, center);
    runtime.writeState(neutral);
    runtime.clearBarrier();
    runtime.disturb(0, 0, 3, "freeze");
    for (let i = 1; i <= 24; i++)
      runtime.disturb(0, 0, 12, "kick_color", {
        dyeColor: [1, 0, 0],
        strength: 0.08 / 60,
        automatic: true,
        lockBarrier: false,
        quantizationPhase: i,
      });
    const data = runtime.readState();
    let positive = 0,
      negative = 0,
      maxOutside = 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const distance = Math.hypot(
          Math.min(x, size - x),
          Math.min(y, size - y),
        );
        const color = colorAt(data, x, y);
        if (distance >= 12)
          maxOutside = Math.max(
            maxOutside,
            ...color.map((v) => Math.abs(v - 127)),
          );
        if (x < 10 && y < 10 && distance > 3)
          positive += Math.abs(color[0] - 127);
        if (x > size - 10 && y > size - 10 && distance > 3)
          negative += Math.abs(color[0] - 127);
      }
    return {
      explicit,
      implicit,
      protected: colorAt(data, 0, 0),
      positive,
      negative,
      maxOutside,
      latentUnchanged: data.every(
        (value, index) => index % 12 < 4 || value === 127,
      ),
      error: runtime.gl.getError(),
    };
  });
  expect(result.error).toBe(0);
  expect(result.explicit[0]).toBeGreaterThan(result.explicit[1]);
  expect(result.implicit).not.toEqual(result.explicit);
  expect(result.protected).toEqual([127, 127, 127]);
  expect(result.maxOutside).toBe(0);
  expect(result.latentUnchanged).toBe(true);
  expect(result.positive).toBeGreaterThan(0);
  expect(result.negative).toBeGreaterThan(0);
});

test("production audio modulation stays fractional and freezes when the clock pauses", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { NeuralGrowthModel } =
      await import("/assets/js/models/neural-growth.js");
    const render = NeuralGrowthModel.prototype.render;
    NeuralGrowthModel.prototype.render = function (
      canvas,
      parameters,
      ...args
    ) {
      window.__audioGrowthModel = this;
      window.__audioGrowthParameters = { ...parameters };
      return render.call(this, canvas, parameters, ...args);
    };
  });
  await selectGrowth(page);
  await page.evaluate(async () => {
    const { rhythmController } =
      await import("/assets/js/core/rhythm-controller.js");
    const { setAudioRoute } =
      await import("/assets/js/core/modulation-matrix.js");
    rhythmController.status = "active";
    rhythmController.levels = {
      generation: 1,
      beatId: 0,
      onsetTimestamp: -Infinity,
      beatStrength: 0,
      hasSignal: true,
      bass: 0.123,
      body: 0.2,
      air: 0.1,
      kick: 0,
      activity: 0.2,
    };
    rhythmController.update = () => rhythmController.levels;
    setAudioRoute("neural-growth", "rotation", {
      source: "audioBass",
      depth: 0.1,
    });
  });
  await page.locator("#toggle-animation").click();
  await expect
    .poll(() => page.evaluate(() => window.__audioGrowthParameters.rotation))
    .toBeCloseTo(2.214, 5);
  await page.locator("#toggle-animation").click();
  const frozen = await page.evaluate(
    () => window.__audioGrowthParameters.rotation,
  );
  await page.evaluate(async () => {
    const { rhythmController } =
      await import("/assets/js/core/rhythm-controller.js");
    rhythmController.levels = {
      ...rhythmController.levels,
      bass: 0.99,
      beatId: 1,
      onsetTimestamp: performance.now(),
      beatStrength: 1,
    };
  });
  await page
    .getByLabel("DISPLAY PALETTE", { exact: true })
    .selectOption("native");
  await page.waitForTimeout(150);
  expect(
    await page.evaluate(() => window.__audioGrowthParameters.rotation),
  ).toBe(frozen);
  expect(
    await page.evaluate(
      () => window.__audioGrowthModel._audioResponse.active.length,
    ),
  ).toBe(0);
  expect(await page.evaluate(() => window.__growthRuntime.gl.getError())).toBe(
    0,
  );
});

test("vitality monitoring uses fenced readback by default and recovery is a saved opt-in switch", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { NeuralGrowthModel } =
      await import("/assets/js/models/neural-growth.js");
    const render = NeuralGrowthModel.prototype.render;
    NeuralGrowthModel.prototype.render = function (...args) {
      window.__vitalityModel = this;
      return render.apply(this, args);
    };
  });
  await selectGrowth(page);
  const toggle = page.getByRole("switch", {
    name: "Automatic recovery",
    exact: true,
  });
  await expect(toggle).not.toBeChecked();
  await expect(page.locator("[data-vitality-status]")).toContainText(
    "recovery off",
  );
  await page.evaluate(() => {
    const runtime = window.__growthRuntime,
      gl = runtime.gl;
    window.__probeReads = { pbo: 0, cpu: 0, copies: 0 };
    const read = gl.readPixels.bind(gl),
      copy = gl.getBufferSubData.bind(gl);
    gl.readPixels = (...args) => {
      window.__probeReads[typeof args.at(-1) === "number" ? "pbo" : "cpu"]++;
      return read(...args);
    };
    gl.getBufferSubData = (...args) => {
      window.__probeReads.copies++;
      return copy(...args);
    };
  });
  await page.locator("#toggle-animation").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__growthRuntime.vitalityProbe?.steps ?? 0),
    )
    .toBeGreaterThan(0);
  await page.locator("#toggle-animation").click();
  const stats = await page.evaluate(() => ({
    ...window.__probeReads,
    slots: window.__growthRuntime._vitalityProbe.slots.length,
    error: window.__growthRuntime.gl.getError(),
  }));
  expect(stats.pbo).toBeGreaterThan(0);
  expect(stats.copies).toBeGreaterThan(0);
  expect(stats.cpu).toBe(0);
  expect(stats.slots).toBe(2);
  expect(stats.error).toBe(0);
  const before = await state(page);
  await toggle.check();
  await expect(toggle).toBeChecked();
  expect(await state(page)).toEqual(before);
  await page.locator("#run-experiment").click();
  await expect(page.locator("#status-message")).toHaveText("Frame saved");
  const record = await page.evaluate(
    () => JSON.parse(localStorage.getItem("latent-field-saved-runs-v1"))[0],
  );
  expect(record.parameters.automaticRecovery).toBe(true);
  await toggle.uncheck();
  await page.locator('[data-view="saved"]').click();
  await page
    .locator(".run-card")
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  const simulation = page.locator('[data-section="simulation"]');
  if ((await simulation.getAttribute("open")) === null)
    await simulation.locator(":scope > summary").click();
  await expect(toggle).toBeChecked();
});

test("erase protection blocks automatic spores, survives until cleared, and resets with the field", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { NeuralGrowthModel } =
      await import("/assets/js/models/neural-growth.js");
    const render = NeuralGrowthModel.prototype.render;
    NeuralGrowthModel.prototype.render = function (...args) {
      window.__vitalityModel = this;
      return render.apply(this, args);
    };
  });
  await selectGrowth(page);
  const result = await page.evaluate(() => {
    const model = window.__vitalityModel,
      runtime = window.__growthRuntime,
      size = runtime.size;
    model.queueDisturbance(size / 2, size / 2, 20, "erase");
    model._drainDisturbances();
    const before = runtime.readState();
    runtime.disturb(size / 2, size / 2, 8, "noise", {
      automatic: true,
      strength: 1,
      quantizationPhase: 1,
    });
    const after = runtime.readState();
    return {
      protected: model._recoveryIntent.cells.some(Boolean),
      unchanged: before.every((value, index) => value === after[index]),
      held: model._vitalityWatchdog.manualUntil - performance.now(),
      error: runtime.gl.getError(),
    };
  });
  expect(result.protected).toBe(true);
  expect(result.unchanged).toBe(true);
  expect(result.held).toBeGreaterThan(7500);
  expect(result.error).toBe(0);
  await page
    .getByRole("button", { name: "Clear erase protection", exact: true })
    .click();
  expect(
    await page.evaluate(() =>
      window.__vitalityModel._recoveryIntent.cells.some(Boolean),
    ),
  ).toBe(false);
  await page.evaluate(() =>
    window.__vitalityModel.queueDisturbance(20, 20, 12, "erase"),
  );
  await page.locator("#restart-growth").click();
  expect(
    await page.evaluate(() =>
      window.__vitalityModel._recoveryIntent.cells.some(Boolean),
    ),
  ).toBe(false);
  expect(await page.evaluate(() => window.__growthRuntime.isDormant())).toBe(
    false,
  );
});

// Advance a controlled simulation clock, but use the production monitor,
// asynchronous GPU readbacks, classifier, seed queue and outcome evaluator.
// No probe values, baselines or watchdog evidence are injected.
async function prepareGpuRecovery(page) {
  await observeVitalityModel(page);
  await selectGrowth(page);
  await page.getByLabel("SIMULATION GRID", { exact: true }).selectOption("128");
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-size",
    "128",
  );
  await page.evaluate(async () => {
    const m = window.__vitalityModel,
      r = m._runtime;
    let now = Math.max(performance.now(), m._vitalityWatchdog.manualUntil) + 1;
    const collect = async () => {
      const previous = r.vitalityProbe;
      now += 600;
      m._monitorVitality(now);
      for (let frame = 0; frame < 900; frame++) {
        await new Promise(requestAnimationFrame);
        m._monitorVitality(++now);
        if (r.vitalityProbe && r.vitalityProbe !== previous)
          return r.vitalityProbe;
      }
      throw new Error(
        `GPU fence timed out: ${JSON.stringify(r.vitalityProbeState)}`,
      );
    };
    const advance = async (count) => {
      m._advanceSimulation(count, now);
      m._vitalityActiveSeconds += count / 12;
      now += (count / 12) * 1000;
      return collect();
    };
    m.setClockRunning(true);
    for (let n = 0; n < 10 && !r.hasRecoverySeed; n++) await advance(16);
    window.__recoveryHarness = {
      m,
      r,
      collect,
      advance,
      diagnostics: () => m.getVitalityDiagnostics(now),
    };
    if (!r.hasRecoverySeed)
      throw new Error("Trusted healthy GPU seed was not learned");
  });
}

for (const fixture of [
  {
    name: "a fixed-point collapsed checkpoint",
    vector: [114, 102, 100, 113, 118, 79, 0, 120, 115, 149, 142, 177],
  },
  {
    name: "flat RGB with static nonzero latent channels",
    vector: [115, 104, 102, 113, 116, 73, 0, 119, 118, 143, 141, 182],
  },
]) {
  test(`Automatic recovery restores sustained visible contrast from ${fixture.name}`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await prepareGpuRecovery(page);
    const before = await page.evaluate(async (vector) => {
      const { r, advance, diagnostics } = window.__recoveryHarness;
      const bytes = new Uint8Array(r.size ** 2 * 12);
      for (let i = 0; i < bytes.length; i++) bytes[i] = vector[i % 12];
      r.writeState(bytes);
      // This is a true checkpoint fixed point, verified over real NCA updates.
      await advance(32);
      await advance(8);
      await advance(8);
      const d = diagnostics();
      return {
        contrast: d.probe.rgbContrast,
        delta: d.probe.hiddenDelta,
        energy: d.probe.hiddenEnergy,
        diagnosis: d.diagnosis,
        admitted: d.recovery.counters.admitted,
        hold: window.__vitalityModel._vitalityWatchdog.manualUntil,
      };
    }, fixture.vector);
    expect(before.contrast).toBeLessThan(0.00001);
    expect(before.delta).toBeLessThan(0.00001);
    expect(before.energy).toBeGreaterThan(0.1);
    expect(before.diagnosis).toBe("visible-flat");
    expect(before.admitted).toBe(0);
    await page.getByRole("switch", { name: "Automatic recovery" }).check();
    expect(
      await page.evaluate(
        () => window.__vitalityModel._vitalityWatchdog.manualUntil,
      ),
    ).toBe(before.hold);
    const result = await page.evaluate(async () => {
      const { r, advance, diagnostics } = window.__recoveryHarness;
      await advance(1);
      const admitted = diagnostics();
      const samples = [];
      for (let n = 0; n < 10; n++) {
        await advance(32);
        const d = diagnostics();
        samples.push({
          steps: r.steps,
          contrast: d.probe.rgbContrast,
          native: d.probe.nativeContrast,
        });
      }
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 128;
      r.draw(canvas, { palette: "native" });
      const pixels = canvas.getContext("2d").getImageData(0, 0, 128, 128).data;
      let sum = 0,
        squared = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const v = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 765;
        sum += v;
        squared += v * v;
      }
      return {
        admitted: admitted.recovery.counters.admitted,
        spores: admitted.recovery.activeSpores,
        counters: diagnostics().recovery.counters,
        outcome: diagnostics().recovery.lastOutcome,
        samples,
        displayContrast: Math.sqrt(squared / 16384 - (sum / 16384) ** 2),
        error: r.gl.getError(),
      };
    });
    expect(result.error).toBe(0);
    expect(result.admitted).toBe(1);
    expect(result.spores).toBe(2);
    expect(result.counters).toEqual({
      admitted: 1,
      applied: 1,
      cancelled: 0,
      succeeded: 1,
      failed: 0,
    });
    expect(result.outcome.reason).toBe("sustained-contrast");
    for (const probe of result.samples.slice(-3)) {
      expect(probe.contrast).toBeGreaterThan(0.03);
      expect(probe.native).toBeGreaterThan(0.06);
    }
    expect(result.displayContrast).toBeGreaterThan(0.04);
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("d");
    await expect(
      page.locator('[data-vitality-field="outcomes"]'),
    ).toContainText("1 succeeded");
  });
}

test("production rescue never changes erase-protected or barrier pixels and frozen grids block automatic admission", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await prepareGpuRecovery(page);
  const report = await page.evaluate(async () => {
    const { m, r, advance, diagnostics } = window.__recoveryHarness;
    // Mark an actual erased patch and a barrier. Compare every protected byte
    // immediately around each rescue dispatch, before the separate NCA update.
    m.queueDisturbance(64, 64, 12, "erase");
    m._drainDisturbances();
    r.disturb(16, 16, 8, "freeze");
    await advance(1);
    await advance(1);
    // Exercise mask clipping inside a spore footprint, rather than only
    // checking that distant protected pixels happen to remain unchanged.
    const tiles = m._eligibleRecoverySeeds(r.vitalityProbe);
    for (let sequence = 1; sequence <= tiles.length; sequence++) {
      const tile = tiles[(sequence * 397) % tiles.length];
      const x = ((tile % 32) + .5) * 4;
      const y = (Math.floor(tile / 32) + .5) * 4;
      const distance = Math.hypot(x-64,y-64);
      if (distance > 18 && distance < 26) {
        m._recoveryIndex = sequence - 1;
        break;
      }
    }
    const base = r.disturb.bind(r);
    let protectedChecks = 0,
      maskedOverlap = false;
    r.disturb = (x, y, radius, mode, options) => {
      if (!options?.automatic) return base(x, y, radius, mode, options);
      const before = r.readState();
      base(x, y, radius, mode, options);
      const after = r.readState();
      for (let row = 0; row < r.size; row++)
        for (let col = 0; col < r.size; col++) {
          const erased = !m._recoveryIntent.allows(
            (col + 0.5) / r.size,
            (row + 0.5) / r.size,
          );
          const frozen = Math.hypot(col - 16, row - 16) <= 8;
          if (!erased && !frozen) continue;
          const dx = Math.min(Math.abs(col - x), r.size - Math.abs(col - x));
          const dy = Math.min(Math.abs(row - y), r.size - Math.abs(row - y));
          if (Math.hypot(dx, dy) < radius) maskedOverlap = true;
          for (let ch = 0; ch < 12; ch++)
            if (
              before[(row * r.size + col) * 12 + ch] !==
              after[(row * r.size + col) * 12 + ch]
            )
              throw new Error("Recovery overrode a protected byte");
        }
      protectedChecks++;
    };
    // Controlled admission exercises the identical protected production queue.
    const queued = m._queueRecoverySpores(
      r.vitalityProbe,
      performance.now() + 100000,
      { test: true },
    );
    await advance(64);
    r.disturb = base;
    m.cancelAudio({ all: true, reason: "test-complete" });
    const admitted = m._vitalityWatchdog.counters.admitted;
    const gl = r.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, r.barrier.framebuffer);
    gl.clearColor(1, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    r.invalidateVitality();
    m.onParameterChange("automaticRecovery", true);
    const frozenBefore = r.readState();
    for (let n = 0; n < 4; n++) await advance(32);
    const d = diagnostics();
    const frozenAfter = r.readState();
    return {
      queued,
      protectedChecks,
      maskedOverlap,
      coverage: d.probe.coverage,
      blockers: d.activeBlockers,
      admittedBefore: admitted,
      admittedAfter: d.recovery.counters.admitted,
      unchanged: frozenBefore.every((v, i) => v === frozenAfter[i]),
      error: gl.getError(),
    };
  });
  expect(report.queued.status).toBe("admitted");
  expect(report.protectedChecks).toBe(128);
  expect(report.maskedOverlap).toBe(true);
  expect(report.coverage).toBe(0);
  expect(report.blockers).toContain("protected-region");
  expect(report.admittedAfter).toBe(report.admittedBefore);
  expect(report.unchanged).toBe(true);
  expect(report.error).toBe(0);
});

test("raw vitality moments detect checkerboards, hidden activity and clipping without display effects", async ({
  page,
}) => {
  await selectGrowth(page);
  const result = await page.evaluate(async () => {
    const runtime = window.__growthRuntime,
      size = runtime.size;
    const data = new Uint8Array(size * size * 12).fill(150);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        for (let channel = 0; channel < 3; channel++)
          data[(y * size + x) * 12 + channel] = (x + y) % 2 ? 190 : 64;
    runtime.writeState(data);
    runtime.steps = 100;
    let timestamp = 10000;
    async function collect() {
      const previous = runtime.vitalityProbe;
      runtime.monitorVitality(timestamp, 5);
      timestamp += 16;
      for (let i = 0; i < 120; i++) {
        await new Promise(requestAnimationFrame);
        const probe = runtime.monitorVitality(timestamp++, 5);
        if (probe && probe !== previous) return probe;
      }
      throw new Error("GPU vitality fence did not complete");
    }
    const constants=[];
    for(const value of [127,20,63]) {
      runtime.writeState(new Uint8Array(data.length).fill(value));
      runtime.steps++; timestamp+=600;
      const flat=await collect();
      constants.push({value,raw:flat.rgbContrast,native:flat.nativeContrast,black:flat.nativeBlackCoverage,rgbClipping:flat.rgbClipping});
    }
    runtime.writeState(data); runtime.steps++; timestamp+=600;
    const first = await collect();
    runtime.draw(document.createElement("canvas"), {
      palette: "neon",
      zoom: 4,
      pan: [0.2, -0.3],
      echoDecay: 0.8,
      ripples: [
        {
          x: 0,
          y: 0,
          radius: 30,
          amplitude: 1,
          startTime: performance.now() - 100,
          duration: 1,
        },
      ],
    });
    runtime.steps++;
    timestamp += 600;
    const display = await collect();
    for (let index = 0; index < data.length; index++)
      if (index % 12 >= 3) data[index] = index % 2 ? 180 : 100;
    runtime.writeState(data); // Explicit writes invalidate generations/history.
    runtime.steps++;
    timestamp += 600;
    await collect();
    // Change hidden channels through a GPU disturbance, retaining prior history.
    runtime.disturb(size / 2, size / 2, size / 2, "noise", {
      automatic: true,
      strength: 1,
      quantizationPhase: 2,
    });
    runtime.steps++;
    timestamp += 600;
    const hidden = await collect();
    runtime.writeState(new Uint8Array(data.length).fill(255));
    runtime.steps++;
    timestamp += 600;
    const clipped = await collect();
    runtime.disturb(size / 2, size / 2, size / 2, "freeze");
    runtime.steps++;
    timestamp += 600;
    const partial = await collect();
    runtime.clearBarrier();
    runtime.gl.bindFramebuffer(
      runtime.gl.FRAMEBUFFER,
      runtime.barrier.framebuffer,
    );
    runtime.gl.clearColor(1, 0, 0, 1);
    runtime.gl.clear(runtime.gl.COLOR_BUFFER_BIT);
    runtime.invalidateVitality();
    runtime.steps++;
    timestamp += 600;
    const frozen = await collect();
    return {
      contrast: first.rgbContrast,
      constants,
      displayed: display.rgbContrast,
      delta: hidden.hiddenDelta,
      clipping: clipped.clipping,
      partial: partial.coverage,
      frozen: frozen.coverage,
      error: runtime.gl.getError(),
    };
  });
  expect(result.error).toBe(0);
  for(const flat of result.constants) {
    expect(flat.raw).toBeLessThan(.000001);
    expect(flat.native).toBeLessThan(.000001);
    expect(flat.black).toBe(flat.value<=63?1:0);
    expect(flat.rgbClipping).toBe(0);
  }
  expect(result.contrast).toBeGreaterThan(0.2);
  expect(result.displayed).toBeCloseTo(result.contrast, 4);
  expect(result.delta).toBeGreaterThan(0.01);
  expect(result.clipping).toBeGreaterThan(0.99);
  expect(result.partial).toBeLessThan(1);
  expect(result.frozen).toBe(0);
});

test("rectangular landscape and portrait runtime rendering is isotropic, toroidal, leak-free, and snapshot-safe", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await selectGrowth(page);

  const report = await page.evaluate(async () => {
    const runtime = window.__growthRuntime;
    const { gl, size } = runtime;

    const drawToSize = (width, height, options = {}) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      runtime.draw(canvas, options);
      return {
        canvas,
        data: canvas.getContext("2d").getImageData(0, 0, width, height).data,
      };
    };

    const echoDims = () =>
      runtime.echoTargets
        ? runtime.echoTargets.map((target) => [target.width, target.height])
        : null;

    const hashTarget = async (target) => {
      const pixels = new Uint8Array(target.width * target.height * 4);
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
      const digest = await crypto.subtle.digest("SHA-256", pixels);
      return [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
    };

    const pixelAt = (data, width, x, y) => {
      const idx = (Math.round(y) * width + Math.round(x)) * 4;
      return [data[idx], data[idx + 1], data[idx + 2]];
    };

    const diffRgb = (a, b) =>
      Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

    const axisSpan = (data, width, height, cx, cy, bg) => {
      let minX = width;
      let maxX = -1;
      for (let x = Math.max(0, cx - 120); x <= Math.min(width - 1, cx + 120); x += 1) {
        if (diffRgb(pixelAt(data, width, x, cy), bg) > 20) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
      }
      let minY = height;
      let maxY = -1;
      for (let y = Math.max(0, cy - 120); y <= Math.min(height - 1, cy + 120); y += 1) {
        if (diffRgb(pixelAt(data, width, cx, y), bg) > 20) {
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
      return {
        spanX: maxX - minX,
        spanY: maxY - minY,
      };
    };

    const neutral = new Uint8Array(size * size * 12).fill(128);
    runtime.clearBarrier();
    runtime.writeState(neutral);
    const { data: bgLandscape } = drawToSize(640, 360, { zoom: 1, pan: [0, 0] });
    const bgCorner = pixelAt(bgLandscape, 640, 10, 10);

    // 1. Center disk stays circular (square texels) in both landscape & portrait.
    runtime.disturb(size / 2, size / 2, 16, "dye", { dyeColor: [0, 1, 0] });
    const landDisk = drawToSize(640, 360, { zoom: 1, pan: [0, 0] });
    const landSpan = axisSpan(landDisk.data, 640, 360, 320, 180, bgCorner);
    const portDisk = drawToSize(360, 480, { zoom: 1, pan: [0, 0] });
    const portSpan = axisSpan(portDisk.data, 360, 480, 180, 240, bgCorner);

    // 2. Toroidal edge repetition in landscape wings and portrait top/bottom wings.
    runtime.writeState(neutral);
    runtime.disturb(Math.round(size * 0.25), Math.round(size * 0.5), 14, "dye", {
      dyeColor: [1, 0, 0],
    });
    runtime.disturb(Math.round(size * 0.5), Math.round(size * 0.05), 12, "dye", {
      dyeColor: [0, 0.5, 1],
    });
    const landWrap = drawToSize(640, 360, { zoom: 1, pan: [0, 0] });
    // Center x=320, minDim=360: x=0.25 is at 320 - 0.25*360 = 230; right wing 320 + 0.75*360 = 590 wraps to 0.25.
    const landCore = pixelAt(landWrap.data, 640, 230, 180);
    const landRightWing = pixelAt(landWrap.data, 640, 590, 180);

    const portWrap = drawToSize(360, 480, { zoom: 1, pan: [0, 0] });
    // Center y=240, minDim=360: ny=0.05 (WebGL bottom) is canvas y = 240 + 0.45*360 = 402;
    // top wing canvas y = 240 - 0.55*360 = 42 maps to ny = 0.5 + 0.55 = 1.05 -> 0.05!
    const portCore = pixelAt(portWrap.data, 360, 180, 402);
    const portTopWing = pixelAt(portWrap.data, 360, 180, 42);

    // 3. Echo FBO allocation, resize resource stability, vortex/julia + ripples + barrier outline.
    runtime.clearBarrier();
    runtime.writeState(neutral);
    runtime.disturb(size / 2, size / 2, 16, "dye", { dyeColor: [1, 0.2, 0.1] });
    runtime.disturb(Math.round(size * 0.25), size / 2, 14, "freeze");
    const baseDrawOpts = {
      zoom: 1,
      pan: [0, 0],
      echoDecay: 0.8,
      echoDrift: 0.25,
      echoMode: "field_advection",
      echoStyle: "phosphor",
      showBarrier: true,
      ripples: [
        {
          x: size / 2,
          y: size / 2,
          radius: 36,
          amplitude: 0.4,
          startTime: performance.now() - 50,
          duration: 1,
        },
      ],
    };

    runtime.step(0, { coordinateTransform: "vortex", twist: 25 });
    drawToSize(640, 360, baseDrawOpts);
    const dims640First = echoDims();
    const res640First = { ...runtime.getStats().resources };

    runtime.step(0, { coordinateTransform: "julia", twist: 0 });
    drawToSize(360, 480, baseDrawOpts);
    const dims360 = echoDims();
    const res360 = { ...runtime.getStats().resources };

    runtime.step(0, { coordinateTransform: "vortex", twist: 20 });
    drawToSize(640, 360, baseDrawOpts);
    const dims640Second = echoDims();
    const res640Second = { ...runtime.getStats().resources };

    // 4. Hi-res widescreen (>=768 long edge) + preserveEchoHistory 2048x2048 snapshot.
    runtime.clearBarrier();
    runtime.writeState(neutral);
    runtime.disturb(size / 2, size / 2, 18, "dye", { dyeColor: [0, 1, 0.5] });
    runtime.step(0, { coordinateTransform: "cartesian", twist: 0 });
    for (let frame = 0; frame < 4; frame += 1) {
      drawToSize(960, 540, {
        ...baseDrawOpts,
        echoMode: "radial_bloom",
        showBarrier: false,
        ripples: [],
      });
    }
    const dims960 = echoDims();
    const echoRefsBefore = [...runtime.echoTargets];
    const echoIndexBefore = runtime.echoIndex;
    const hashesBefore = [
      await hashTarget(runtime.echoTargets[0]),
      await hashTarget(runtime.echoTargets[1]),
    ];

    const snap2k = drawToSize(2048, 2048, {
      ...baseDrawOpts,
      echoMode: "radial_bloom",
      showBarrier: false,
      ripples: [],
      preserveEchoHistory: true,
    });
    const echoRefsAfter = [...runtime.echoTargets];
    const echoIndexAfter = runtime.echoIndex;
    const hashesAfter = [
      await hashTarget(runtime.echoTargets[0]),
      await hashTarget(runtime.echoTargets[1]),
    ];

    // Snapshot center disk + echoed halo remains circular (not stretched to 16:9).
    const snapBg = pixelAt(snap2k.data, 2048, 50, 50);
    let snapMinX = 2048;
    let snapMaxX = -1;
    for (let x = 600; x <= 1448; x += 1) {
      if (diffRgb(pixelAt(snap2k.data, 2048, x, 1024), snapBg) > 20) {
        snapMinX = Math.min(snapMinX, x);
        snapMaxX = Math.max(snapMaxX, x);
      }
    }
    let snapMinY = 2048;
    let snapMaxY = -1;
    for (let y = 600; y <= 1448; y += 1) {
      if (diffRgb(pixelAt(snap2k.data, 2048, 1024, y), snapBg) > 20) {
        snapMinY = Math.min(snapMinY, y);
        snapMaxY = Math.max(snapMaxY, y);
      }
    }

    return {
      landSpan,
      portSpan,
      landCoreDiff: diffRgb(landCore, bgCorner),
      landWrapDiff: diffRgb(landCore, landRightWing),
      portCoreDiff: diffRgb(portCore, bgCorner),
      portWrapDiff: diffRgb(portCore, portTopWing),
      dims640First,
      dims360,
      dims640Second,
      dims960,
      res640First,
      res360,
      res640Second,
      sameEchoRefs:
        echoRefsBefore[0] === echoRefsAfter[0] &&
        echoRefsBefore[1] === echoRefsAfter[1],
      sameEchoIndex: echoIndexBefore === echoIndexAfter,
      sameEchoHashes:
        hashesBefore[0] === hashesAfter[0] &&
        hashesBefore[1] === hashesAfter[1],
      snapSpanX: snapMaxX - snapMinX,
      snapSpanY: snapMaxY - snapMinY,
      glError: gl.getError(),
    };
  });

  expect(report.glError).toBe(0);
  expect(report.landSpan.spanX).toBeGreaterThan(25);
  expect(Math.abs(report.landSpan.spanX - report.landSpan.spanY)).toBeLessThanOrEqual(2);
  expect(report.portSpan.spanX).toBeGreaterThan(25);
  expect(Math.abs(report.portSpan.spanX - report.portSpan.spanY)).toBeLessThanOrEqual(2);
  expect(Math.abs(report.landSpan.spanX - report.portSpan.spanX)).toBeLessThanOrEqual(2);
  expect(report.landCoreDiff).toBeGreaterThan(40);
  expect(report.landWrapDiff).toBeLessThanOrEqual(8);
  expect(report.portCoreDiff).toBeGreaterThan(40);
  expect(report.portWrapDiff).toBeLessThanOrEqual(8);

  expect(report.dims640First).toEqual([
    [640, 360],
    [640, 360],
  ]);
  expect(report.dims360).toEqual([
    [360, 480],
    [360, 480],
  ]);
  expect(report.dims640Second).toEqual([
    [640, 360],
    [640, 360],
  ]);
  expect(report.dims960).toEqual([
    [768, 432],
    [768, 432],
  ]);
  expect(report.res640Second.textures).toBe(report.res640First.textures);
  expect(report.res640Second.framebuffers).toBe(report.res640First.framebuffers);
  expect(report.res640Second.bytes).toBe(report.res640First.bytes);
  expect(report.res360.textures).toBe(report.res640First.textures);
  expect(report.sameEchoRefs).toBe(true);
  expect(report.sameEchoIndex).toBe(true);
  expect(report.sameEchoHashes).toBe(true);
  expect(report.snapSpanX).toBeGreaterThan(150);
  expect(Math.abs(report.snapSpanX - report.snapSpanY)).toBeLessThanOrEqual(8);
  expect(errors).toEqual([]);
});

test("widescreen fullscreen fills panel, wraps wing clicks cleanly, and generates 220x220 thumbnails", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await selectGrowth(page);
  await page.locator("#toggle-fullscreen").click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.id))
    .toBe("output-panel");

  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const panel = document.getElementById("output-panel").getBoundingClientRect();
        const canvas = document.getElementById("output-canvas");
        const rect = canvas.getBoundingClientRect();
        return (
          canvas.width > canvas.height &&
          Math.abs(rect.width - panel.width) <= 2 &&
          Math.abs(rect.height - panel.height) <= 2 &&
          Math.abs(rect.width / rect.height - canvas.width / canvas.height) < 0.01
        );
      });
    })
    .toBe(true);

  await page.evaluate(() => {
    window.__wingDisturbances = [];
    const runtime = window.__growthRuntime;
    const disturb = runtime.disturb;
    runtime.disturb = function (...args) {
      window.__wingDisturbances.push(args.slice(0, 3));
      return disturb.apply(this, args);
    };
  });

  const rect = await page.locator("#output-canvas").boundingBox();
  const minSide = Math.min(rect.width, rect.height);
  // Click inside the left widescreen wing (-0.65 * minSide from center -> nx = 0.85, gx = 217).
  await page.mouse.click(
    rect.x + rect.width / 2 - minSide * 0.65,
    rect.y + rect.height / 2,
  );
  await expect
    .poll(() => page.evaluate(() => window.__wingDisturbances.at(-1)))
    .toEqual([217, 128, 16]);

  // Click inside the right widescreen wing (+0.65 * minSide from center -> nx = 0.15, gx = 38).
  await page.mouse.click(
    rect.x + rect.width / 2 + minSide * 0.65,
    rect.y + rect.height / 2,
  );
  await expect
    .poll(() => page.evaluate(() => window.__wingDisturbances.at(-1)))
    .toEqual([38, 128, 16]);

  // Save while still in rectangular widescreen fullscreen so thumbnail center-cropping runs.
  await page.keyboard.press("Control+Enter");
  await expect(page.locator("#status-message")).toContainText("saved");

  await page.keyboard.press("f");
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement))
    .toBe(null);

  await page.locator('[data-view="saved"]').click();
  await expect(page.locator(".run-card")).toHaveCount(1);
  const thumbSize = await page
    .locator(".run-card__image")
    .first()
    .evaluate(async (img) => {
      await img.decode();
      return { width: img.naturalWidth, height: img.naturalHeight };
    });
  expect(thumbSize).toEqual({ width: 220, height: 220 });
  expect(errors).toEqual([]);
});

test("GPU geometry field matches finite circular reference samples and grooming seams", async ({
  page,
}) => {
  const { geometrySamples } = await import("../helpers/geometry-reference.mjs");
  const samples = geometrySamples();
  const results = await page.evaluate(async (samples) => {
    const { GEOMETRY_GLSL } =
      await import("/assets/js/models/neural-growth/geometry-field.js");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const gl = canvas.getContext("webgl2", { antialias: false });
    if (!gl) throw new Error("WebGL2 unavailable");
    const shader = (type, source) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(
      program,
      shader(
        gl.VERTEX_SHADER,
        `#version 300 es
      void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2),float(gl_VertexID & 2)); gl_Position=vec4(p*2.0-1.0,0,1); }`,
      ),
    );
    gl.attachShader(
      program,
      shader(
        gl.FRAGMENT_SHADER,
        `#version 300 es
      precision highp float; precision highp int;
      uniform int u_size, u_transform, u_kind;
      uniform float u_twist, u_geometryStrength, u_geometrySoftness, u_foldCount, u_base, u_target;
      uniform vec2 u_pos;
      out vec4 result;
      ${GEOMETRY_GLSL}
      void main() {
        float theta = geometryAngle(u_pos,u_base);
        if (u_kind == 1) theta = circularMix(u_base,u_target,u_geometryStrength);
        if (u_kind == 2) theta = directionAngle(u_pos,u_base);
        vec2 dir = angleDirection(theta);
        result=vec4(dir*.5+.5,finiteAngle(theta)?1.0:0.0,length(dir)*.5);
      }`,
      ),
    );
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    gl.disable(gl.DITHER);
    gl.viewport(0, 0, 1, 1);
    const f = (name, value) =>
      gl.uniform1f(gl.getUniformLocation(program, name), value);
    const i = (name, value) =>
      gl.uniform1i(gl.getUniformLocation(program, name), value);
    const output = [];
    const run = ({ pos, options = {} }, kind = 0) => {
      i("u_size", options.size ?? 256);
      i("u_transform", options.mode ?? 0);
      i("u_kind", kind);
      f("u_twist", options.twist ?? 0);
      f("u_geometryStrength", options.strength ?? 1);
      f("u_geometrySoftness", options.softness ?? 0.25);
      f("u_foldCount", options.folds ?? 6);
      f("u_base", options.base ?? 0);
      f("u_target", options.target ?? 0);
      gl.uniform2f(gl.getUniformLocation(program, "u_pos"), ...pos);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const pixel = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return [...pixel];
    };
    for (const sample of samples) output.push(run(sample));
    const half = run(
      { pos: [0, 0], options: { base: 0, target: Math.PI, strength: 0.5 } },
      1,
    );
    const groom = run(
      {
        pos: [0, 0],
        options: {
          base: Math.PI - 0.01,
          target: -Math.PI + 0.01,
          strength: 0.5,
        },
      },
      1,
    );
    const zero = run({ pos: [0, 0], options: { base: 0.6 } }, 2);
    const overflow = run({ pos: [1e10, -1e10], options: { mode: 3, base: 0.6, twist: 0.2 } });
    const error = gl.getError();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { output, half, groom, zero, overflow, error };
  }, samples);
  expect(results.error).toBe(0);
  for (let n = 0; n < samples.length; n++) {
    const actual = results.output[n],
      { expected } = samples[n];
    expect(actual[2], JSON.stringify(samples[n])).toBe(255);
    expect(actual[3]).toBeGreaterThanOrEqual(127);
    expect(actual[3]).toBeLessThanOrEqual(128);
    expect(
      Math.abs((actual[0] / 255) * 2 - 1 - Math.cos(expected)),
      JSON.stringify(samples[n]),
    ).toBeLessThan(0.025);
    expect(
      Math.abs((actual[1] / 255) * 2 - 1 - Math.sin(expected)),
      JSON.stringify(samples[n]),
    ).toBeLessThan(0.025);
  }
  expect(Math.abs((results.half[1] / 255) * 2 - 1)).toBeGreaterThan(0.99);
  expect(results.groom[0]).toBe(0);
  expect(
    Math.abs((results.zero[0] / 255) * 2 - 1 - Math.cos(0.6)),
  ).toBeLessThan(0.01);
  expect(results.overflow[2]).toBe(255);
  expect(Math.abs((results.overflow[0] / 255) * 2 - 1 - Math.cos(0.6))).toBeLessThan(0.01);
  expect(Math.abs((results.overflow[1] / 255) * 2 - 1 - Math.sin(0.6))).toBeLessThan(0.01);
});

test("paused geometry edits reach echo uniforms and diagnostics without stepping or reading state", async ({
  page,
}) => {
  await observeVitalityModel(page);
  await selectGrowth(page);
  const before = await state(page);
  await page.evaluate(() => {
    const r = window.__growthRuntime;
    window.__geometryReads = 0;
    const read = r.readState.bind(r);
    r.readState = (...args) => {
      window.__geometryReads++;
      return read(...args);
    };
  });
  await page
    .getByLabel("COORDINATE GEOMETRY", { exact: true })
    .selectOption("kaleidoscope");
  await page
    .getByLabel("SPIRAL PITCH / TWIST exact value", { exact: true })
    .fill("45");
  await page
    .getByLabel("SPIRAL PITCH / TWIST exact value", { exact: true })
    .dispatchEvent("change");
  await expect
    .poll(() => page.evaluate(() => window.__growthRuntime.twist))
    .toBeCloseTo(Math.PI / 4, 5);
  await expect
    .poll(() => page.evaluate(() => window.__growthRuntime.coordinateTransform))
    .toBe("kaleidoscope");
  const after = await page.evaluate(() => ({
    steps: window.__growthRuntime.steps,
    reads: window.__geometryReads,
    applied:
      window.__vitalityModel.getVitalityDiagnostics().geometry.applied
        .coordinateTransform,
  }));
  expect(after).toEqual({
    steps: before.steps,
    reads: 0,
    applied: "kaleidoscope",
  });
});

for (const pattern of ["mixed4c-439", "membrane-field"]) {
  test(`sustained GPU geometry stability across modes, pitch extremes and grooming: ${pattern}`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await selectGrowth(page);
    const results = await page.evaluate(async (pattern) => {
      const { TextureNcaRuntime } =
        await import("/assets/js/models/neural-growth/runtime.js");
      const { getPattern } =
        await import("/assets/js/models/neural-growth/patterns.js");
      const { validateCheckpoint } =
        await import("/assets/js/models/neural-growth/reference.js");
      const model = validateCheckpoint(
        await (await fetch(getPattern(pattern).checkpointUrl)).json(),
      );
      const r = new TextureNcaRuntime({ model, size: 128, seed: 1 });
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 144;
      const stats = (data) => {
        let variance = 0,
          clipping = 0;
        for (let ch = 0; ch < 3; ch++) {
          let sum = 0,
            squared = 0;
          for (let n = ch; n < data.length; n += 12) {
            const v = data[n] / 255;
            sum += v;
            squared += v * v;
          }
          const count = data.length / 12;
          variance += Math.max(0, squared / count - (sum / count) ** 2) / 3;
        }
        for (const v of data) if (v <= 2 || v >= 253) clipping++;
        return {
          contrast: Math.sqrt(variance),
          clipping: clipping / data.length,
        };
      };
      try {
        r.step(128);
        const warm = r.readState(),
          baseline = stats(warm),
          out = [];
        const cases = [
          { coordinateTransform: "vortex" },
          { coordinateTransform: "vortex", geometryStrength: 1 },
          { coordinateTransform: "saddle" },
          {
            coordinateTransform: "spiral",
            twist: Math.PI / 2,
            geometrySoftness: 0,
          },
          {
            coordinateTransform: "spiral",
            twist: Math.PI / 2,
            geometrySoftness: 0,
            geometryStrength: 1,
          },
          {
            coordinateTransform: "spiral",
            twist: -Math.PI / 2,
            geometrySoftness: 0,
          },
          { coordinateTransform: "julia" },
          { coordinateTransform: "dipole" },
          { coordinateTransform: "vortex_pair", twist: -0.01 },
          { coordinateTransform: "wave" },
          { coordinateTransform: "kaleidoscope", foldCount: 6 },
          { coordinateTransform: "voronoi" },
        ];
        for (const parameters of cases) {
          r.restart(1);
          r.writeState(warm);
          // Put the focus exactly on a cell center, default to 50% Strength, and paint
          // across the grooming +/-pi seam before stepping.
          const options = {
            rotation: 0,
            twist: 0,
            foldCount: 6,
            geometryStrength: 0.5,
            geometrySoftness: 0.25,
            geometryCenterX: 1 / 128,
            geometryCenterY: 1 / 128,
            ...parameters,
          };
          r.disturb(40, 64, 12, "groom", { strokeAngle: 0 });
          r.disturb(40, 64, 12, "groom", { strokeAngle: Math.PI });
          r.disturb(64, 64, 12, "groom", { strokeAngle: Math.PI - 0.01 });
          r.disturb(64, 64, 12, "groom", { strokeAngle: -Math.PI + 0.01 });
          const measurements = [];
          let previous = warm;
          for (let frame = 0; frame < 3; frame++) {
            r.step(64, options);
            r.draw(canvas, {
              palette: "native",
              echoDecay: 0.8,
              echoDrift: 0.4,
              echoMode: frame === 2 ? "radial_bloom" : "field_advection",
            });
            const raw = r.readState();
            let delta = 0;
            for (let n = 0; n < raw.length; n++)
              delta += Math.abs(raw[n] - previous[n]) / 255;
            measurements.push({ ...stats(raw), delta: delta / raw.length });
            previous = raw;
          }
          const pixels = canvas
            .getContext("2d")
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let min = 255,
            max = 0;
          for (let n = 0; n < pixels.length; n++)
            if (n % 4 !== 3) {
              min = Math.min(min, pixels[n]);
              max = Math.max(max, pixels[n]);
            }
          out.push({
            parameters,
            measurements,
            displayRange: max - min,
            error: r.gl.getError(),
            lost: r.gl.isContextLost(),
          });
        }
        return { baseline, out };
      } finally {
        r.dispose();
      }
    }, pattern);
    expect(results.baseline.contrast).toBeGreaterThan(0.005);
    for (const entry of results.out) {
      expect(entry.error, JSON.stringify(entry)).toBe(0);
      expect(entry.lost).toBe(false);
      expect(entry.displayRange, JSON.stringify(entry)).toBeGreaterThan(5);
      for (const metrics of entry.measurements) {
        expect(metrics.contrast, JSON.stringify(entry)).toBeGreaterThan(0.004);
        expect(metrics.clipping, JSON.stringify(entry)).toBeLessThan(0.85);
        expect(metrics.delta, JSON.stringify(entry)).toBeGreaterThan(0.0001);
      }
    }
  });
}
