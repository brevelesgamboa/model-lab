import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.abort(),
  );
  await page.goto("/");
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
});

test("the footer keeps EQ beside Audio and uses quiet status and log messages", async ({
  page,
}) => {
  await expect(page.locator("#app-status-bar #audio-meter")).toBeVisible();
  await expect(page.locator("#canvas-status-bar #audio-meter")).toHaveCount(0);
  await expect(page.locator(".live-indicator, .drawer-badge")).toHaveCount(0);
  await expect(page.locator("#toggle-audio-input")).toHaveText("Audio: Off");
  await page.locator("#toggle-animation").click();
  await expect(page.locator("#status-message")).toHaveText("Playing");
  await page.locator("#toggle-animation").click();
  await expect(page.locator("#status-message")).toHaveText("Paused");
  await page.locator("#toggle-terminal").click();
  await expect(page.locator(".terminal-panel")).not.toContainText(
    "LOCAL SESSION",
  );
  await expect(page.locator("#terminal-output")).not.toContainText(">BOOT");
  await expect(page.locator("#terminal-output")).toContainText("Ready");
});

test("reference chrome and brush rail frame the canvas without overlays", async ({
  page,
}) => {
  const header = await page.locator("#app-header").boundingBox();
  const footer = await page.locator("#app-status-bar").boundingBox();
  const sidebar = await page.locator(".input-panel").boundingBox();
  expect(header).toMatchObject({ x: 0, y: 0, height: 56 });
  expect(footer.height).toBe(56);
  expect(sidebar.width).toBe(320);
  expect(sidebar.y).toBe(56);
  expect(sidebar.y + sidebar.height).toBe(footer.y);
  await expect(page.locator("#growth-canvas-tools")).toBeHidden();
  await page.locator("#model-select").selectOption("neural-growth");
  await expect(page.locator("#step-growth")).toBeEnabled();
  const rail = await page.locator("#growth-canvas-tools").boundingBox();
  expect(rail.width).toBe(44);
  const stage = await page.locator(".output-stage").boundingBox();
  expect(rail.y).toBe(stage.y);
  expect(rail.x + rail.width).toBe(header.width - 6);
  expect(rail.y + rail.height).toBe(stage.y + stage.height);
  const [first, second] = await page
    .locator(".growth-brush-btn")
    .evaluateAll((buttons) =>
      buttons.slice(0, 2).map((button) => ({
        top: button.getBoundingClientRect().top,
        bottom: button.getBoundingClientRect().bottom,
      })),
    );
  expect(second.top - first.bottom).toBe(6);
  await page
    .getByRole("button", { name: "Flow / Vector", exact: true })
    .click();
  await expect(page.locator('[data-brush="groom"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator("#model-select").selectOption("folded-fractal");
  await expect(page.locator("#growth-canvas-tools")).toBeHidden();
});

test("view switches preserve the canvas, GPU runtime, and paused NCA state", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { TextureNcaRuntime } =
      await import("/assets/js/models/neural-growth/runtime.js");
    const draw = TextureNcaRuntime.prototype.draw;
    TextureNcaRuntime.prototype.draw = function (...args) {
      window.__growthRuntime = this;
      return draw.apply(this, args);
    };
    window.__originalCanvas = document.getElementById("output-canvas");
  });
  await page.locator("#model-select").selectOption("neural-growth");
  await expect(page.locator("#step-growth")).toBeEnabled();
  const before = await page.evaluate(() => {
    window.__originalRuntime = window.__growthRuntime;
    return Array.from(window.__growthRuntime.readState());
  });
  for (const view of ["saved", "experiments", "about"]) {
    await page.locator(`[data-view="${view}"]`).click();
    await expect(page.locator(`#view-${view}`)).toBeVisible();
    await expect(page.locator(`#view-${view}`)).not.toBeEmpty();
    await expect(page.locator("#view-lab")).toHaveClass(/hidden/);
  }
  await page.locator('[data-view="lab"]').click();
  await expect(page.locator("#view-lab")).toBeVisible();
  const after = await page.evaluate(() => ({
    sameCanvas:
      document.getElementById("output-canvas") === window.__originalCanvas,
    sameRuntime: window.__growthRuntime === window.__originalRuntime,
    state: Array.from(window.__growthRuntime.readState()),
    lost: window.__growthRuntime.getStats().contextLost,
  }));
  expect(after.sameCanvas).toBe(true);
  expect(after.sameRuntime).toBe(true);
  expect(after.lost).toBe(false);
  expect(after.state).toEqual(before);
});

test("range, numeric stepper, preset, and reset update the rendered shader", async ({
  page,
}) => {
  const control = page.locator('[data-parameter="scale"]');
  const slider = control.locator(".control-slider");
  const number = control.locator(".fine-input");
  const initial = Number(await number.inputValue());
  const initialPixels = await page
    .locator("#output-canvas")
    .evaluate((canvas) => canvas.toDataURL());
  await slider.fill("2.5");
  await expect(number).toHaveValue("2.5");
  await expect
    .poll(() =>
      page.locator("#output-canvas").evaluate((canvas) => canvas.toDataURL()),
    )
    .not.toBe(initialPixels);
  await control.locator(".nudge-button").last().click();
  expect(Number(await number.inputValue())).toBeGreaterThan(2.5);
  await number.fill("1.6");
  await expect(slider).toHaveValue("1.6");
  expect(
    await slider.evaluate((input) =>
      parseFloat(input.style.getPropertyValue("--range-progress")),
    ),
  ).toBeGreaterThan(0);
  await page.locator("#reset-parameters").click();
  await expect(
    page.locator('[data-parameter="scale"] .fine-input'),
  ).toHaveValue(String(initial));
  await page.locator("#model-select").selectOption("fractal-functions");
  await page.locator("#classic-fractal-view").selectOption("seahorse-valley");
  await expect(
    page.locator('[data-parameter="zoomExponent"] .fine-input'),
  ).toHaveValue("3.05");
  await expect(page.locator("#status-message")).toContainText("loaded");
});

test("the compact drawer controls direction, phase and logarithmic rate without duplicate routing", async ({
  page,
}) => {
  const control = page.locator('[data-parameter="scale"]');
  await control.locator(".fine-input").fill("2.4");
  await control.locator(".modulation-toggle").click();
  const drawer = control.locator(".modulation-drawer");
  await expect(page.locator(".existing-routing")).toHaveCount(0);
  await expect(
    drawer.getByLabel("COORDINATE SCALE LFO rate range", { exact: true }),
  ).toHaveValue("slow");
  const hz = drawer.getByLabel("COORDINATE SCALE LFO rate in Hz", {
    exact: true,
  });
  await expect(hz).toHaveValue("0.05");
  await hz.fill("1.25");
  await hz.dispatchEvent("change");
  await expect(
    drawer.getByLabel("COORDINATE SCALE LFO rate range", { exact: true }),
  ).toHaveValue("full");
  await drawer
    .getByLabel("COORDINATE SCALE modulation enabled", { exact: true })
    .check();
  await drawer
    .getByLabel("COORDINATE SCALE LFO depth percent", { exact: true })
    .fill("20");
  await drawer.getByRole("button", { name: "Full", exact: true }).click();
  await drawer.getByRole("button", { name: "Kick", exact: true }).click();
  await drawer
    .getByLabel("COORDINATE SCALE audio modulation depth", { exact: true })
    .fill("0.5");
  await drawer
    .getByRole("button", {
      name: "COORDINATE SCALE audio depth below base",
      exact: true,
    })
    .click();
  const strip = control.getByRole("slider", {
    name: "COORDINATE SCALE LFO amount",
    exact: true,
  });
  const range = control.locator(".modulation-track__range");
  await expect.poll(() => range.evaluate((el) => el.style.left)).toBe("40%");
  await expect.poll(() => range.evaluate((el) => el.style.width)).toBe("20%");
  const polarity = drawer.getByLabel("COORDINATE SCALE modulation direction", {
    exact: true,
  });
  await polarity.selectOption("positive");
  await expect.poll(() => range.evaluate((el) => el.style.left)).toBe("50%");
  await expect.poll(() => range.evaluate((el) => el.style.width)).toBe("10%");
  await expect(strip).toHaveAttribute("aria-valuetext", "20%, above base");
  await polarity.selectOption("negative");
  await expect.poll(() => range.evaluate((el) => el.style.left)).toBe("40%");
  await expect.poll(() => range.evaluate((el) => el.style.width)).toBe("10%");
  await expect(strip).toHaveAttribute("aria-valuetext", "20%, below base");
  const phase = drawer.locator(".drawer-playhead");
  const first = await phase.getAttribute("x1");
  await expect.poll(() => phase.getAttribute("x1")).not.toBe(first);
  await page.locator("#toggle-animation").click();
  await expect(page.locator("#status-message")).toHaveText("Paused");
  const before = Number(await phase.getAttribute("x1"));
  await drawer
    .getByLabel("COORDINATE SCALE LFO phase", { exact: true })
    .fill("90");
  await expect(page.locator("#toggle-animation")).toHaveText("CLOCK: OFF");
  await expect
    .poll(
      async () => (Number(await phase.getAttribute("x1")) - before + 256) % 256,
    )
    .toBeCloseTo(64, 0);
  await expect(drawer.locator(".drawer-value output")).toHaveText(
    /^\d+\.\d{2}$/,
  );
  await expect(drawer.locator(".drawer-value")).toHaveCSS(
    "white-space",
    "nowrap",
  );
  await drawer
    .getByLabel("COORDINATE SCALE waveform", { exact: true })
    .selectOption("triangle");
  await drawer.getByRole("button", { name: "Off", exact: true }).click();
  await expect(
    drawer.getByLabel("COORDINATE SCALE audio modulation depth", {
      exact: true,
    }),
  ).toBeDisabled();
  await page.locator("#model-select").selectOption("fractal-functions");
  await page.locator("#model-select").selectOption("folded-fractal");
  await expect(
    control.getByLabel("COORDINATE SCALE modulation direction", {
      exact: true,
    }),
  ).toHaveValue("negative");
  await expect(
    control.getByLabel("COORDINATE SCALE LFO phase", { exact: true }),
  ).toHaveValue("90");
  await expect(
    control.getByLabel("COORDINATE SCALE LFO rate in Hz", { exact: true }),
  ).toHaveValue("1.25");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator("#status-message")).toHaveText("Frame saved");
  await page.locator("#reset-parameters").click();
  await page.locator('[data-view="saved"]').click();
  await page
    .locator(".run-card")
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  await expect(
    control.getByLabel("COORDINATE SCALE modulation direction", {
      exact: true,
    }),
  ).toHaveValue("negative");
  await expect(
    control.getByLabel("COORDINATE SCALE LFO phase", { exact: true }),
  ).toHaveValue("90");
});

test("dragging and keyboard adjustment of the blue strip change depth while preserving the base", async ({
  page,
}) => {
  const control = page.locator('[data-parameter="scale"]');
  await control.locator(".fine-input").fill("2.4");
  const strip = control.getByRole("slider", {
    name: "COORDINATE SCALE LFO amount",
    exact: true,
  });
  await strip.focus();
  await strip.press("ArrowRight");
  await expect(strip).toHaveAttribute("aria-valuenow", "25");
  await expect(page.locator("#status-message")).toHaveText("Playing");
  const main = await control.locator(".control-slider").boundingBox();
  const track = await strip.boundingBox();
  expect(track.y).toBeGreaterThanOrEqual(main.y + main.height);
  const handle = await strip
    .locator(".modulation-track__handle--end")
    .boundingBox();
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2 + track.width * 0.1,
    handle.y + handle.height / 2,
    { steps: 6 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => Number(await strip.getAttribute("aria-valuenow")))
    .toBeCloseTo(45, 0);
  await expect(control.locator(".fine-input")).toHaveValue("2.4");
  await control.locator(".modulation-toggle").click();
  await expect(
    control.getByLabel("COORDINATE SCALE LFO depth percent", { exact: true }),
  ).toHaveValue("45");
  await strip.focus();
  await strip.press("Home");
  await expect(strip).toHaveAttribute("aria-valuenow", "0");
  await strip.press("End");
  await expect(strip).toHaveAttribute("aria-valuenow", "100");
  await expect(
    control.getByLabel("COORDINATE SCALE LFO depth percent", { exact: true }),
  ).toHaveValue("100");
});

test("global detector settings synchronize across drawers independently of signed audio depth", async ({
  page,
}) => {
  const first = page.locator('[data-parameter="scale"]');
  const second = page.locator('[data-parameter="rotation"]');
  await first.locator(".modulation-toggle").click();
  await second.locator(".modulation-toggle").click();
  await first.locator(".drawer-global-settings > summary").click();
  await second.locator(".drawer-global-settings > summary").click();
  await first
    .getByLabel("COORDINATE SCALE global input gain", { exact: true })
    .fill("1.7");
  await first
    .getByLabel("COORDINATE SCALE global kick threshold", { exact: true })
    .fill("0.1");
  await first
    .getByLabel("COORDINATE SCALE global kick gate", { exact: true })
    .fill("0.08");
  await expect(
    second.getByLabel("ITERATION ROTATION global input gain", { exact: true }),
  ).toHaveValue("1.7");
  await expect(
    second.getByLabel("ITERATION ROTATION global kick threshold", {
      exact: true,
    }),
  ).toHaveValue("0.1");
  await expect(
    second.getByLabel("ITERATION ROTATION global kick gate", { exact: true }),
  ).toHaveValue("0.08");
  await first.getByRole("button", { name: "Full", exact: true }).click();
  await first
    .getByLabel("COORDINATE SCALE audio modulation depth", { exact: true })
    .fill("0.8");
  const negative = first.getByRole("button", {
    name: "COORDINATE SCALE audio depth below base",
    exact: true,
  });
  await negative.click();
  await expect(negative).toHaveAttribute("aria-pressed", "true");
  await expect(first.locator(".drawer-audio output")).toHaveText("-80%");
  const state = await page.evaluate(async () => {
    const { rhythmController } =
      await import("/assets/js/core/rhythm-controller.js");
    const { getAudioRoute } =
      await import("/assets/js/core/modulation-matrix.js");
    return {
      gain: rhythmController.inputGain,
      offset: rhythmController.kickOffset,
      gate: rhythmController.kickGate,
      route: getAudioRoute("folded-fractal", "scale"),
    };
  });
  expect(state).toEqual({
    gain: 1.7,
    offset: 0.1,
    gate: 0.08,
    route: { source: "bass", depth: -0.8 },
  });
  await page.locator("#model-select").selectOption("fractal-functions");
  await page.locator("#model-select").selectOption("folded-fractal");
  await expect(first.locator(".drawer-audio")).toHaveAttribute(
    "data-source",
    "bass",
  );
  await expect(
    first.getByLabel("COORDINATE SCALE audio modulation depth", {
      exact: true,
    }),
  ).toHaveValue("0.8");
  await expect(negative).toHaveAttribute("aria-pressed", "true");
  await first
    .getByRole("button", {
      name: "COORDINATE SCALE audio depth above base",
      exact: true,
    })
    .click();
  await expect(first.locator(".drawer-audio output")).toHaveText("80%");
  const depth = first.getByLabel("COORDINATE SCALE audio modulation depth", {
    exact: true,
  });
  await depth.fill("0");
  await negative.click();
  await depth.fill("0.3");
  await expect(first.locator(".drawer-audio output")).toHaveText("-30%");
  expect(
    await page.evaluate(async () => {
      const { getAudioRoute } =
        await import("/assets/js/core/modulation-matrix.js");
      return getAudioRoute("folded-fractal", "scale").depth;
    }),
  ).toBe(-0.3);
});

for (const width of [360, 900, 1440]) {
  test(`canvas aspect and utilities fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await expect(page.locator("#render-state")).toHaveText("FRAME READY");
    const layout = await page.evaluate(() => {
      const canvas = document.getElementById("output-canvas");
      const rect = canvas.getBoundingClientRect();
      const cfg = document
        .getElementById("open-visualizer-settings")
        .getBoundingClientRect();
      return {
        right: rect.right,
        left: rect.left,
        ratio: rect.width / rect.height,
        bufferRatio: canvas.width / canvas.height,
        cfgRight: cfg.right,
        width: innerWidth,
      };
    });
    expect(layout.right).toBeLessThanOrEqual(width);
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.ratio).toBeCloseTo(layout.bufferRatio, 3);
    expect(layout.cfgRight).toBeLessThanOrEqual(width);
    if (width <= 800) {
      await expect(page.locator("#model-select")).toBeHidden();
      await page.locator("#toggle-input").click();
      await expect(page.locator("#model-select")).toBeVisible();
    }
  });
}

test("quality, fullscreen resizing, and GIF export retain the original hooks", async ({
  page,
}) => {
  await page.locator("#quality-select").selectOption("economy");
  await expect(page.locator("#output-resolution")).toHaveText("384 × 384");
  await page.locator("#toggle-fullscreen").click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.id))
    .toBe("output-panel");
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
  await page.keyboard.press("f");
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement))
    .toBeNull();
  await expect(page.locator("#output-resolution")).toHaveText("384 × 384");
  const downloaded = page.waitForEvent("download");
  await page.locator("#save-gif").click();
  expect((await downloaded).suggestedFilename()).toMatch(/\.gif$/);
  await expect(page.locator("#save-gif")).toBeEnabled();
  await expect(page.locator("#toggle-animation")).toHaveText("CLOCK: OFF");
});

test("the render surface contains no labels and controls stay outside its frame", async ({
  page,
}) => {
  await expect(page.locator(".output-frame")).toHaveText("");
  await expect(page.locator(".output-stage")).toHaveText("");
  await expect(page.locator("#explore-hint")).toBeHidden();
  await expect(page.locator("#render-state")).toBeHidden();
  await expect(
    page.locator("#canvas-status-bar #output-resolution"),
  ).toBeVisible();
  await expect(page.locator("#output-panel .viewport-caption")).toHaveCount(0);
  await page.locator("#model-select").selectOption("fractal-functions");
  await expect(
    page.locator(".input-panel #classic-fractal-view"),
  ).toBeVisible();
  await expect(page.locator(".output-stage")).toHaveText("");
});

test("brush settings expand below the tools and scroll within the rail", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 560 });
  await page.locator("#model-select").selectOption("neural-growth");
  await expect(page.locator("#step-growth")).toBeEnabled();
  await page.locator('[data-brush="dye"]').click();
  await expect(page.locator("#brush-settings")).toHaveAttribute("open", "");
  const layout = await page
    .locator("#growth-brush-options")
    .evaluate((options) => {
      const rail = options.closest(".tool-rail");
      const preview = document
        .querySelector("#brush-settings > summary")
        .getBoundingClientRect();
      const bounds = options.getBoundingClientRect();
      const railBounds = rail.getBoundingClientRect();
      return {
        position: getComputedStyle(options).position,
        top: bounds.top,
        previewBottom: preview.bottom,
        left: bounds.left,
        right: bounds.right,
        railLeft: railBounds.left,
        railRight: railBounds.right,
        scrollable: rail.scrollHeight > rail.clientHeight,
        overflow: getComputedStyle(rail).overflowY,
      };
    });
  expect(layout.position).toBe("static");
  expect(layout.top).toBeGreaterThanOrEqual(layout.previewBottom);
  expect(layout.left).toBeGreaterThanOrEqual(layout.railLeft);
  expect(layout.right).toBeLessThanOrEqual(layout.railRight);
  expect(layout.scrollable).toBe(true);
  expect(layout.overflow).toBe("auto");
  await page.locator("#growth-brush-radius").scrollIntoViewIfNeeded();
  await page.locator("#growth-brush-radius").fill("24");
  await expect(page.locator("#growth-brush-radius-val")).toHaveText("24px");
  await expect(
    page.locator('[data-parameter="brushRadius"] .fine-input'),
  ).toHaveValue("24");
  await page.locator('#growth-color-options [data-color="#ff00a0"]').click();
  await expect(page.locator("#growth-color-picker")).toHaveValue("#ff00a0");
  await page.locator('[data-brush="freeze"]').click();
  await expect(page.locator("#growth-freeze-options")).toBeVisible();
  await page.locator('[data-brush="thaw"]').click();
  await expect(page.locator('[data-brush="thaw"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("#growth-brush-radius")).toHaveValue("24");
});
