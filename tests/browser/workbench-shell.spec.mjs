import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.abort(),
  );
  await page.goto("/");
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
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
    await expect(page.locator(`#view-${view}`)).toBeEmpty();
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
  await expect(page.locator("#status-message")).toContainText("LOADED");
});

test("the SVG modulation draft is isolated and existing routing stays functional", async ({
  page,
}) => {
  const control = page.locator('[data-parameter="scale"]');
  const toggle = control.locator(".modulation-toggle");
  const originalValue = await control.locator(".fine-input").inputValue();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(control.locator(".draft-waveform")).toBeVisible();
  const draft = control.locator(".modulation-draft");
  await draft.getByLabel("Preview LFO rate").fill("1.25");
  await expect(draft.locator("output").first()).toHaveText("1.25 Hz");
  await draft.getByRole("button", { name: "FULL", exact: true }).click();
  await expect(draft.locator(".draft-audio")).toHaveAttribute(
    "data-source",
    "full",
  );
  await draft.getByRole("button", { name: "KICK", exact: true }).click();
  await expect(
    draft.getByRole("button", { name: "KICK", exact: true }),
  ).toHaveCSS("color", "rgb(217, 119, 6)");
  await expect(control.locator(".fine-input")).toHaveValue(originalValue);
  await expect(page.locator("#toggle-animation")).toHaveText("CLOCK: OFF");
  await control.locator(".existing-routing > summary").click();
  await control
    .getByLabel("Enable COORDINATE SCALE LFO", { exact: true })
    .check();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#toggle-animation")).toHaveText("CLOCK: ON");
  await toggle.click();
  await expect(control.locator(".modulation-panel")).toHaveClass(/hidden/);
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
  await expect(page.locator("#output-resolution")).toHaveText("384 x 384");
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
