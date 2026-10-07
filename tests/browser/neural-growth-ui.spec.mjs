import { test, expect } from "@playwright/test";

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
  await expect(page.locator("#status-message")).toContainText("READY");
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
  await expect(page.locator("#step-growth")).toBeEnabled();
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-size",
    "128",
  );
}

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
  await expect(page.locator("#status-message")).toContainText("READY");
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
  await expect(page.locator(".modulation-toggle:visible")).toHaveCount(2);
  await expect(page.locator("#save-gif")).toBeDisabled();
  await expect(page.locator("#run-experiment")).toBeDisabled();
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
  for (const view of ["archive", "experiments", "about", "lab"]) {
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

test("PNG is an immutable snapshot, with no fictitious high-resolution or Saved Run capture", async ({
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
  await expect(page.locator("#export-option-2k input")).toBeDisabled();
  await expect(page.locator("#export-option-4k input")).toBeDisabled();
  const download = page.waitForEvent("download");
  await page.locator("#export-modal-confirm").click();
  expect((await download).suggestedFilename()).toMatch(
    /^Neural_Growth_.*\.png$/,
  );
  await expect(page.locator("#status-message")).toContainText(
    "PNG SNAPSHOT EXPORTED",
  );
  expect(await state(page)).toEqual(before);
  await page.keyboard.press("Control+Enter");
  await expect(page.locator("#status-message")).toContainText(
    "SAVED RUNS DO NOT STORE GRID STATE",
  );
  await page.locator('[data-view="archive"]').click();
  await expect(page.locator(".run-card")).toHaveCount(0);
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
  await page.getByLabel("SIMULATION GRID", { exact: true }).selectOption("256");
  await expect(page.locator("#growth-status")).toHaveAttribute(
    "data-size",
    "256",
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
    .toEqual([64, 95, 8]);
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

  await expect
    .poll(async () => (await state(page)).hash)
    .not.toBe(before.hash);

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
  await selectGrowth(page);
  const galleryBtn = page.locator("#open-growth-gallery");
  await expect(galleryBtn).toBeVisible();
  await galleryBtn.click();

  const dialog = page.locator("#growth-gallery-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.locator("#growth-gallery-count")).toContainText("69");

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

  // Select pattern from gallery
  const card = page.locator(".growth-gallery__card").first();
  await card.click();
  await expect(dialog).not.toBeVisible();

  // Selected pattern should now be loaded
  await expect
    .poll(() => page.evaluate(() => window.__growthRuntime.model.id))
    .toBe("bubbly-0101");
});

test("continuous rotation and growth speed expose modulation controls with circular wrapping", async ({
  page,
}) => {
  await selectGrowth(page);
  // Ensure rotation has MOD button and circular wrap works
  const rotationMod = page.locator('button.modulation-toggle[data-key="rotation"]');
  await expect(rotationMod).toBeVisible();

  const speedMod = page.locator('button.modulation-toggle[data-key="growthSpeed"]');
  await expect(speedMod).toBeVisible();

  // Test circular wrap on rotation
  const wrapped = await page.evaluate(async () => {
    const { coerceRangeValue } = await import(
      "/assets/js/app/controls-controller.js"
    );
    const def = { min: 0, max: 360, step: 1, wrap: true };
    return [
      coerceRangeValue(def, 375),
      coerceRangeValue(def, -15),
      coerceRangeValue(def, 720),
    ];
  });
  expect(wrapped).toEqual([15, 345, 0]);
});

