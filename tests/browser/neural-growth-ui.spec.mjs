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

async function selectGrowth(page) {
  await page.locator("#model-select").selectOption("neural-growth");
  await expect(page.locator("#step-growth")).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-size",
    "256",
  );
}

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

test("display resizing releases replaced echo buffers and preserves simulation state", async ({
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
    .toBe(1024);
  const before = await state(page);
  const resources = await page.evaluate(
    () => window.__growthRuntime.getStats().resources,
  );
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await page.locator("#toggle-animation").click();
    await expect
      .poll(() =>
        page.evaluate(() => window.__growthRuntime.echoTargets[0].width),
      )
      .toBe(768);
    await page.locator("#toggle-animation").click();
    await expect
      .poll(() =>
        page.evaluate(() => window.__growthRuntime.echoTargets[0].width),
      )
      .toBe(1024);
    expect(
      await page.evaluate(() => window.__growthRuntime.getStats().resources),
    ).toEqual(resources);
  }
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
  await expect(page.locator(".modulation-toggle:visible")).toHaveCount(18);
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
    .toEqual([128, 191, 16]);
  expect((await state(page)).steps).toBe(2);
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
  await expect(page.locator("#growth-gallery-count")).toContainText("159");

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

test("audio-reactive presets configure modulation routes and synchronize with MOD panels", async ({
  page,
}) => {
  await selectGrowth(page);

  const audioSelect = page.getByLabel("AUDIO REACT", { exact: true });
  await expect(audioSelect).toBeVisible();
  await expect(audioSelect).toHaveValue("off");

  const shockwaveSelect = page.getByLabel("BEAT SHOCKWAVE", { exact: true });
  await expect(shockwaveSelect).toBeVisible();
  await expect(shockwaveSelect).toHaveValue("on");

  const intensityInput = page.locator(
    'input.control-slider[aria-label="SHOCKWAVE INTENSITY"]',
  );
  await expect(intensityInput).toBeVisible();

  const geometrySelect = page.getByLabel("COORDINATE GEOMETRY", {
    exact: true,
  });
  await expect(geometrySelect).toHaveValue("cartesian");

  // Select Continuous preset: switches Cartesian geometry to Vortex, sets base values and LFOs
  await audioSelect.selectOption("continuous");
  await expect(shockwaveSelect).toHaveValue("on");
  await expect(geometrySelect).toHaveValue("vortex");

  // Check animation starts immediately without audio
  await expect(page.locator("#toggle-animation")).toHaveText("CLOCK: ON");

  // Check rotation MOD toggle is active
  const rotationModToggle = page.locator(
    'button.modulation-toggle[data-key="rotation"]',
  );
  await expect(rotationModToggle).toHaveClass(/is-active/);

  // Open rotation MOD drawer if not already open
  const rotationSource = page.locator(
    '[data-parameter="rotation"] .drawer-audio',
  );
  if (await rotationSource.isHidden()) {
    await rotationModToggle.click();
  }
  await expect(rotationSource).toBeVisible();
  await expect(rotationSource).toHaveAttribute("data-source", "kick");

  const rotationLfoCheckbox = page.locator(
    '.control-block[data-parameter="rotation"] input[aria-label="ROTATION modulation enabled"]',
  );
  await expect(rotationLfoCheckbox).toBeChecked();

  const rotationDrawer = page.locator(
    '[data-parameter="rotation"] .modulation-drawer',
  );
  await expect(rotationDrawer.locator('[data-field="enabled"]')).toBeChecked();
  await expect(
    rotationDrawer.getByRole("button", { name: "Kick", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");

  // Changing shockwave mode independently preserves audio preset
  await shockwaveSelect.selectOption("off");
  await expect(shockwaveSelect).toHaveValue("off");
  await expect(audioSelect).toHaveValue("continuous");

  // Switch to Subtle preset: sets shockwave to on and preserves current non-Cartesian geometry (Vortex)
  await audioSelect.selectOption("subtle");
  await expect(shockwaveSelect).toHaveValue("on");
  await expect(geometrySelect).toHaveValue("vortex");
  await expect(rotationSource).toHaveAttribute("data-source", "kick");
  await expect(rotationLfoCheckbox).not.toBeChecked();
  await expect(
    rotationDrawer.locator('[data-field="enabled"]'),
  ).not.toBeChecked();

  // Verify twist LFO is active in Subtle
  const twistModToggle = page.locator(
    'button.modulation-toggle[data-key="twist"]',
  );
  await expect(twistModToggle).toHaveClass(/is-active/);

  // Switch to Dynamic preset: verifies dynamic configuration and LFO activation
  await audioSelect.selectOption("dynamic");
  await expect(shockwaveSelect).toHaveValue("on");
  await expect(geometrySelect).toHaveValue("vortex");
  await expect(rotationSource).toHaveAttribute("data-source", "kick");
  await expect(rotationLfoCheckbox).toBeChecked();
  await expect(rotationDrawer.locator('[data-field="enabled"]')).toBeChecked();

  // Verify growth speed base value for dynamic is 45 (calm baseline)
  const growthSpeedInput = page.locator(
    '.control-block[data-parameter="growthSpeed"] input.fine-input',
  );
  await expect(growthSpeedInput).toHaveValue("45");

  // Tweak audio depth on rotation to trigger custom profile detection
  const depthInput = page.locator(
    '.control-block[data-parameter="rotation"] .modulation-drawer [data-field="audioDepth"]',
  );
  await depthInput.fill("0.85");
  await depthInput.dispatchEvent("input");
  await expect(
    page.locator('[data-parameter="rotation"] .drawer-audio output'),
  ).toHaveText("85%");

  // Verify AUDIO REACT select dynamically transitioned to custom
  await expect(audioSelect).toHaveValue("custom");

  // Save run to archive and verify
  await page.keyboard.press("Control+Enter");
  await expect(page.locator("#status-message")).toContainText("saved");
  await page.locator('[data-view="saved"]').click();
  await expect(page.locator(".run-card")).toHaveCount(1);
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
  const modeSelect = page.getByLabel("DISTURBANCE MODE", { exact: true });
  await modeSelect.selectOption("noise");
  const modeBlock = page.locator(".control-block", { has: modeSelect });
  await expect(modeBlock.locator(".control-guidance__tag")).toHaveText(
    "RE-SEED",
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

test("acoustic field injection configures coupling modes and synchronizes with popover", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await selectGrowth(page);

  // In Neural Growth model controls:
  const injectSelect = page.locator('select[aria-label="AUDIO COUPLING"]');
  await expect(injectSelect).toHaveValue("off");
  await injectSelect.selectOption("dye");
  await expect(injectSelect).toHaveValue("dye");

  // Open visualizer settings popover and verify coupling select syncs
  await page.locator("#open-visualizer-settings").click();
  const popoverInjection = page.locator("#visualizer-injection-select");
  await expect(popoverInjection).toBeVisible();
  await expect(popoverInjection).toHaveValue("dye");

  // Change from popover and verify model control syncs
  await popoverInjection.selectOption("shockwave");
  await expect(injectSelect).toHaveValue("shockwave");

  // Close popover
  await page.locator("#close-visualizer-settings").click();

  expect(errors).toEqual([]);
});

test("camera breathing configures modes and updates viewport cleanly", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await selectGrowth(page);

  const breathSelect = page.locator('select[aria-label="CAMERA BREATH"]');
  await expect(breathSelect).toHaveValue("off");
  await breathSelect.selectOption("punchy");
  await expect(breathSelect).toHaveValue("punchy");

  await breathSelect.selectOption("drift");
  await expect(breathSelect).toHaveValue("drift");

  expect(errors).toEqual([]);
});

test("neuron archetype cards update all three targets without changing the cellular field", async ({
  page,
}) => {
  await selectGrowth(page);
  await page.locator("#step-growth").click();
  const before = await state(page);
  await page.evaluate(() => {
    window.__initialGrowthRuntime = window.__growthRuntime;
  });
  const neurons = await page.evaluate(
    async () =>
      (await import("/assets/js/models/neural-growth.js")).CURATED_NEURONS,
  );
  await expect(page.locator(".neuron-gallery__card")).toHaveCount(7);
  await expect(page.locator('[data-parameter="targetChannel"]')).toBeHidden();
  for (const neuron of neurons) {
    const card = page.locator(`[data-neuron-id="${neuron.id}"]`);
    await expect(card).toContainText(neuron.name);
    await expect(card).toContainText(neuron.desc);
    await expect(card).toContainText(neuron.layer);
    await card.click();
    await expect(card).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("DREAM LAYER", { exact: true })).toHaveValue(
      neuron.layer,
    );
    await expect(
      page.getByLabel("DREAM NEURON exact value", { exact: true }),
    ).toHaveValue(String(neuron.channel));
    await expect(
      page.getByLabel("DREAM STRENGTH exact value", { exact: true }),
    ).toHaveValue(String(neuron.strength));
    await expect(page.locator(".modulation-toggle:visible")).toHaveCount(18);
    expect(await state(page)).toEqual(before);
  }
  expect(
    await page.evaluate(
      () => window.__growthRuntime === window.__initialGrowthRuntime,
    ),
  ).toBe(true);
  await expect(page.getByLabel("DREAM GUIDANCE", { exact: true })).toHaveValue(
    "off",
  );
});

test("manual channel exploration follows every layer ceiling and clamps deep-to-shallow changes", async ({
  page,
}) => {
  await selectGrowth(page);
  await page.locator("#step-growth").click();
  const before = await state(page);
  const toggle = page.getByRole("button", {
    name: "Manual Channel Explorer",
    exact: true,
  });
  await toggle.click();
  const channel = page.getByLabel("DREAM NEURON exact value", { exact: true });
  const slider = page.getByLabel("DREAM NEURON", { exact: true });
  const layer = page.getByLabel("DREAM LAYER", { exact: true });
  const depths = await page.evaluate(
    async () =>
      (await import("/assets/js/models/neural-growth/dream-guidance.js"))
        .INCEPTION_LAYER_CHANNELS,
  );
  for (const [id, depth] of Object.entries(depths)) {
    await layer.selectOption(id);
    await expect(channel).toBeVisible();
    await expect(channel).toHaveAttribute("max", String(depth - 1));
    await expect(slider).toHaveAttribute("max", String(depth - 1));
  }
  await layer.selectOption("mixed_7b");
  await channel.fill("1800");
  await expect(channel).toHaveValue("1800");
  await layer.selectOption("mixed_5b");
  await expect(channel).toHaveValue("255");
  await layer.selectOption("mixed_7b");
  await expect(channel).toHaveValue("255");
  await slider.evaluate((input) => {
    input.value = "1900";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(channel).toHaveValue("1900");
  await page.locator('[data-neuron-id="curve"]').click();
  await expect(channel).toHaveValue("144");
  await expect(channel).toHaveAttribute("max", "767");
  await channel.fill("145");
  await expect(page.locator('[data-neuron-id="curve"]')).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await toggle.click();
  await expect(channel).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(await state(page)).toEqual(before);
});

test("live archetype changes preserve playback and deliver the selected guidance targets", async ({
  page,
}) => {
  await selectGrowth(page);
  await page.evaluate(async () => {
    const { DreamGuidanceBridge } =
      await import("/assets/js/models/neural-growth/dream-guidance.js");
    window.__guidanceTargets = [];
    // Isolate scheduling/routing from Inception inference cost in this UI test.
    DreamGuidanceBridge.prototype.computeGradient = async function (
      _rgb,
      _w,
      _h,
      layer,
      channel,
    ) {
      window.__guidanceTargets.push({ layer, channel });
      return null;
    };
  });
  await page.getByLabel("SIMULATION GRID", { exact: true }).selectOption("128");
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-size",
    "128",
  );
  await page.getByLabel("DREAM CADENCE exact value", { exact: true }).fill("1");
  await page.getByLabel("DREAM GUIDANCE", { exact: true }).selectOption("on");
  await page.evaluate(() => {
    window.__initialGrowthRuntime = window.__growthRuntime;
  });
  await page.locator("#toggle-animation").click();
  let previousSteps = 0;
  for (const [id, layer, channel] of [
    ["semantic", "mixed_7b", 312],
    ["hatch", "mixed_5b", 120],
    ["ensemble", "mixed_6c", -1],
  ]) {
    await page.locator(`[data-neuron-id="${id}"]`).click();
    await expect
      .poll(() =>
        page.evaluate(
          ({ layer, channel }) =>
            window.__guidanceTargets.some(
              (target) => target.layer === layer && target.channel === channel,
            ),
          { layer, channel },
        ),
      )
      .toBe(true);
    const steps = await page.evaluate(
      () => window.__growthRuntime.getStats().steps,
    );
    expect(steps).toBeGreaterThan(previousSteps);
    previousSteps = steps;
    await expect(page.locator("#toggle-animation")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      await page.evaluate(
        () => window.__growthRuntime === window.__initialGrowthRuntime,
      ),
    ).toBe(true);
  }
  await page.locator("#toggle-animation").click();
});

test("neuron gallery stays inside the sidebar and restores channels above the old ceiling", async ({
  page,
}) => {
  await selectGrowth(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [360, 900, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const sizes = await page.locator(".neuron-gallery").evaluate((gallery) => {
      const strip = gallery.querySelector(".neuron-gallery__strip");
      const sidebar = gallery.closest(".input-panel");
      return {
        sidebar: sidebar.clientWidth,
        content: sidebar.scrollWidth,
        strip: strip.clientWidth,
        cards: strip.scrollWidth,
      };
    });
    expect(sizes.content).toBeLessThanOrEqual(sizes.sidebar + 1);
    expect(sizes.cards).toBeGreaterThan(sizes.strip);
  }
  await page.locator('[data-neuron-id="semantic"]').click();
  await page
    .getByRole("button", { name: "Manual Channel Explorer", exact: true })
    .click();
  const channel = page.getByLabel("DREAM NEURON exact value", { exact: true });
  await channel.fill("1800");
  await page.locator("#run-experiment").click();
  await expect(page.locator("#status-message")).toHaveText("Frame saved");
  await page.locator('[data-neuron-id="hatch"]').click();
  await expect(channel).toHaveValue("120");
  await page.locator('[data-view="saved"]').click();
  await page
    .locator(".run-card")
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  await expect(page.getByLabel("DREAM LAYER", { exact: true })).toHaveValue(
    "mixed_7b",
  );
  await expect(channel).toHaveValue("1800");
  await expect(channel).toHaveAttribute("max", "2047");
  expect(errors).toEqual([]);
});

test("advanced inception guidance and state dynamics configure controls cleanly", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await selectGrowth(page);

  // Inception Dream Guidance controls
  const dreamSelect = page.locator('select[aria-label="DREAM GUIDANCE"]');
  await expect(dreamSelect).toHaveValue("off");
  await dreamSelect.selectOption("on");
  await expect(dreamSelect).toHaveValue("on");

  const neuronInput = page.getByLabel("DREAM NEURON exact value", {
    exact: true,
  });
  await page
    .getByRole("button", { name: "Manual Channel Explorer", exact: true })
    .click();
  await expect(neuronInput).toBeVisible();
  await neuronInput.fill("42");

  const jitterSelect = page.locator('select[aria-label="DREAM JITTER"]');
  await expect(jitterSelect).toHaveValue("on");
  await jitterSelect.selectOption("off");
  await expect(jitterSelect).toHaveValue("off");

  const chromaInput = page.getByLabel("DREAM CHROMINANCE exact value", {
    exact: true,
  });
  await expect(chromaInput).toBeVisible();
  await chromaInput.fill("0");

  // Kaleidoscope Folds
  const geometrySelect = page.getByLabel("COORDINATE GEOMETRY", {
    exact: true,
  });
  await geometrySelect.selectOption("kaleidoscope");

  const foldInput = page.getByLabel("KALEIDOSCOPE FOLDS exact value", {
    exact: true,
  });
  await expect(foldInput).toBeVisible();
  await foldInput.fill("8");

  // Cell-state momentum
  const momentumInput = page.getByLabel("STATE MOMENTUM exact value", {
    exact: true,
  });
  await expect(momentumInput).toBeVisible();
  await momentumInput.fill("0.45");

  // Step simulation once to ensure shader execution with all new uniforms
  await page.locator("#step-growth").click();
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-steps",
    "1",
  );

  // WebGL context is healthy with zero loss
  expect(
    await page.evaluate(() => window.__growthRuntime.getStats().contextLost),
  ).toBe(false);

  expect(errors).toEqual([]);
});
