import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.abort(),
  );
});

test("audio visualizer overlay toggles cleanly, opens settings popover and configures parameters", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await expect(page.locator("#render-state")).not.toHaveText("BOOTING");

  const toggleBtn = page.locator("#toggle-audio-visualizer");
  const cfgBtn = page.locator("#open-visualizer-settings");
  const popover = page.locator("#visualizer-settings-popover");
  const overlayCanvas = page.locator("#audio-visualizer-canvas");

  await expect(toggleBtn).toBeVisible();
  await expect(toggleBtn).toHaveText("WAVE: OFF");
  await expect(overlayCanvas).toBeHidden();

  // Pointer events must pass through to output canvas
  const pointerEvents = await overlayCanvas.evaluate((el) =>
    window.getComputedStyle(el).pointerEvents,
  );
  expect(pointerEvents).toBe("none");

  // Toggle visualizer on
  await toggleBtn.click();
  await expect(toggleBtn).toHaveText("WAVE: ON");
  await expect(toggleBtn).toHaveClass(/is-active/);
  await expect(toggleBtn).toHaveAttribute("aria-pressed", "true");
  await expect(overlayCanvas).toBeVisible();

  // Open settings popover
  await expect(popover).toBeHidden();
  await cfgBtn.click();
  await expect(popover).toBeVisible();

  // Configure mode, style and fill
  const modeSelect = page.locator("#visualizer-mode-select");
  await modeSelect.selectOption("bass_history");
  await expect(modeSelect).toHaveValue("bass_history");

  const styleSelect = page.locator("#visualizer-style-select");
  await styleSelect.selectOption("mirrored");
  await expect(styleSelect).toHaveValue("mirrored");

  const heightRange = page.locator("#visualizer-height-range");
  await heightRange.fill("0.35");
  await expect(page.locator("#visualizer-height-val")).toHaveText("35%");

  const opacityRange = page.locator("#visualizer-opacity-range");
  await opacityRange.fill("0.65");
  await expect(page.locator("#visualizer-opacity-val")).toHaveText("65%");

  // Test custom color picker
  const colorPicker = page.locator("#visualizer-color-picker");
  await colorPicker.fill("#33aaff");
  await expect(colorPicker).toHaveValue("#33aaff");

  // Test color pill selection
  const magentaPill = page.locator('#visualizer-color-pills [data-color="#ff00a0"]');
  await magentaPill.click();
  await expect(magentaPill).toHaveClass(/is-active/);

  // Close with close button
  const closeBtn = page.locator("#close-visualizer-settings");
  await closeBtn.click();
  await expect(popover).toBeHidden();

  // Re-open and dismiss with Escape
  await cfgBtn.click();
  await expect(popover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  // Re-open and dismiss with outside click
  await cfgBtn.click();
  await expect(popover).toBeVisible();
  await page.locator("#status-message").click();
  await expect(popover).toBeHidden();

  // Toggle visualizer off
  await toggleBtn.click();
  await expect(toggleBtn).toHaveText("WAVE: OFF");
  await expect(toggleBtn).not.toHaveClass(/is-active/);
  await expect(overlayCanvas).toBeHidden();

  expect(errors).toEqual([]);
});

