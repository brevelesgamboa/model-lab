import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.abort(),
  );
  await page.goto("/");
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
});

test("real Inception feature previews encode 64px WebP without retaining tensors", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const result = await page.evaluate(async () => {
    const { InceptionDreamModel } =
      await import("/assets/js/models/inception-dream.js");
    const { generateNeuronPreview } =
      await import("/assets/js/models/neural-growth/dream-guidance.js");
    const owner = new InceptionDreamModel();
    let timer;
    try {
      const model = await owner.ensureModel();
      // Warm graph/kernel caches for both endpoints before measuring retained tensors.
      await generateNeuronPreview(model, "mixed_6c", -1, 64, 1);
      await generateNeuronPreview(model, "mixed_7b", 5000, 64, 1);
      const baseline = globalThis.tf.memory().numTensors;
      let ticks = 0;
      timer = setInterval(() => {
        ticks += 1;
      }, 5);
      const urls = [
        await generateNeuronPreview(model, "mixed_6c", -1, 64, 30),
        await generateNeuronPreview(model, "mixed_7b", 5000, 64, 2),
      ];
      const retained = globalThis.tf.memory().numTensors - baseline;
      const images = [];
      for (const url of urls) {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 64;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, 64, 64).data;
        let min = 255;
        let max = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          min = Math.min(min, pixels[index]);
          max = Math.max(max, pixels[index]);
        }
        images.push({
          dataUrl: url.startsWith("data:image/webp;base64,"),
          width: image.naturalWidth,
          height: image.naturalHeight,
          range: max - min,
        });
      }
      return { retained, ticks, images };
    } finally {
      clearInterval(timer);
      await owner.dispose();
    }
  });
  expect(result.retained).toBe(0);
  expect(result.ticks).toBeGreaterThanOrEqual(30);
  for (const image of result.images) {
    expect(image.dataUrl).toBe(true);
    expect(image.width).toBe(64);
    expect(image.height).toBe(64);
    expect(image.range).toBeGreaterThan(1);
  }
});

async function installPreviewFixture(page, { bundled = false } = {}) {
  await page.evaluate(async (useBundled) => {
    const { DreamGuidanceBridge } =
      await import("/assets/js/models/neural-growth/dream-guidance.js");
    const { TextureNcaRuntime } =
      await import("/assets/js/models/neural-growth/runtime.js");
    const draw = TextureNcaRuntime.prototype.draw;
    TextureNcaRuntime.prototype.draw = function (...args) {
      window.__previewRuntime = this;
      return draw.apply(this, args);
    };
    const loadBundled = DreamGuidanceBridge.prototype.loadBundledPreviews;
    DreamGuidanceBridge.prototype.loadBundledPreviews = async function () {
      window.__previewBridge = this;
      if (useBundled) return loadBundled.call(this);
      this._previewNamespace = "fixture-checkpoint:fourier-v2:96:96";
      return this.previewCache;
    };
    DreamGuidanceBridge.prototype.ensureModel = async function () {
      return {};
    };
    const start = DreamGuidanceBridge.prototype._startPreviewQueue;
    DreamGuidanceBridge.prototype._startPreviewQueue = function () {
      window.__previewBridge = this;
      this._generatePreview = async (
        _model,
        layer,
        channel,
        size,
        _steps,
        { beforeStep, onProgress },
      ) => {
        await beforeStep();
        window.__previewCalls ??= [];
        window.__previewResults ??= {};
        window.__previewCalls.push(`${layer}_${channel}`);
        if (channel === window.__slowChannel)
          await new Promise((resolve) => setTimeout(resolve, 1200));
        await beforeStep();
        if (channel === window.__failChannel && !window.__previewFailed) {
          window.__previewFailed = true;
          throw new Error("Temporary preview failure");
        }
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const context = canvas.getContext("2d");
        context.fillStyle = `hsl(${(channel + 360) % 360} 60% 50%)`;
        context.fillRect(0, 0, size, size);
        const url = canvas.toDataURL("image/webp", 0.85);
        window.__previewResults[`${layer}_${channel}`] = url;
        onProgress?.(96, 96);
        return url;
      };
      return start.call(this);
    };
  }, bundled);
}

async function openGrowth(page) {
  await page.locator("#model-select").selectOption("neural-growth");
  await expect(page.locator("#step-growth")).toBeEnabled();
  const dreamSection = page.locator('[data-section="dream"]');
  if (!(await dreamSection.evaluate((section) => section.open)))
    await dreamSection.locator(":scope > summary").click();
}

async function field(page) {
  return page.evaluate(async () => ({
    steps: window.__previewRuntime.steps,
    hash: Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          window.__previewRuntime.readState(),
        ),
      ),
    ),
  }));
}

test("manual channel previews follow exact layer bounds, reuse cache, and preserve the cellular field", async ({
  page,
}) => {
  await installPreviewFixture(page);
  await openGrowth(page);
  await page.locator("#step-growth").click();
  const before = await field(page);
  await page
    .getByRole("button", { name: "Preview selected neuron", exact: true })
    .click();
  const image = page.locator(".neuron-selected-preview img");
  await expect(image).toBeVisible();
  await page
    .getByRole("button", { name: "Manual Channel Explorer", exact: true })
    .click();
  await page
    .getByLabel("DREAM LAYER", { exact: true })
    .selectOption("mixed_7b");
  const channel = page.getByLabel("DREAM NEURON exact value", { exact: true });
  await channel.evaluate((input) => {
    for (const value of ["1700", "1800"]) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await expect(page.locator(".neuron-selected-preview figcaption")).toHaveText(
    "mixed_7b · Channel #1800",
  );
  expect(
    await page.evaluate(() =>
      window.__previewBridge.previewCache.has("mixed_7b_1800"),
    ),
  ).toBe(false);
  await page
    .getByRole("button", { name: "Preview selected neuron", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__previewBridge.previewCache.has("mixed_7b_1800"),
      ),
    )
    .toBe(true);
  const expected = await page.evaluate(
    () => window.__previewResults.mixed_7b_1800,
  );
  await expect(image).toHaveAttribute("src", expected);
  expect(
    await page.evaluate(() => window.__previewCalls.includes("mixed_7b_1700")),
  ).toBe(false);
  await page
    .getByLabel("DREAM LAYER", { exact: true })
    .selectOption("mixed_5b");
  await expect(channel).toHaveValue("255");
  await expect(channel).toHaveAttribute("max", "255");
  await expect(page.locator(".neuron-selected-preview figcaption")).toHaveText(
    "mixed_5b · Channel #255",
  );
  await page
    .getByLabel("DREAM LAYER", { exact: true })
    .selectOption("mixed_7b");
  await channel.fill("1800");
  await expect(image).toHaveAttribute("src", expected);
  expect(
    await page.evaluate(
      () =>
        window.__previewCalls.filter((key) => key === "mixed_7b_1800").length,
    ),
  ).toBe(1);
  expect(await field(page)).toEqual(before);
  await page.locator('[data-view="about"]').click();
  await page.locator('[data-view="lab"]').click();
  await expect(image).toHaveAttribute("src", expected);
  expect(
    await page.evaluate(() => window.__previewBridge._previewListeners.size),
  ).toBe(2);
  expect(await field(page)).toEqual(before);
});

test("layer-grouped gallery searches every channel and selects without changing strength or playback", async ({
  page,
}) => {
  await installPreviewFixture(page);
  await openGrowth(page);
  await page.locator("#step-growth").click();
  const before = await field(page);
  await page
    .getByLabel("DREAM STRENGTH exact value", { exact: true })
    .fill("0.37");
  await page
    .getByRole("button", { name: "Browse neuron previews", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Neuron explorer",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByLabel("Explorer layer").locator("optgroup"),
  ).toHaveCount(4);
  await dialog.getByLabel("Preview collection").selectOption("all");
  await expect(dialog.locator(".neuron-explorer__card")).toHaveCount(12);
  await dialog.getByRole("button", { name: "Next neuron page" }).click();
  await expect(
    dialog.locator(".neuron-explorer__pagination [role='status']"),
  ).toContainText("13–24");
  await dialog.getByLabel("Explorer layer").selectOption("mixed_7b");
  await dialog.getByLabel("Find neuron channel").fill("2047");
  const card = dialog.locator('.neuron-explorer__card[data-channel="2047"]');
  await expect(dialog.locator(".neuron-explorer__card")).toHaveCount(1);
  await expect(card.locator("img")).toBeHidden();
  await card.click();
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Generate neuron preview", exact: true })
    .click();
  await expect(card.locator("img")).toBeVisible();
  expect(await field(page)).toEqual(before);
  for (const width of [360, 900, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
  }
  await dialog
    .getByRole("button", { name: "Use as Dream target", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByLabel("DREAM LAYER", { exact: true })).toHaveValue(
    "mixed_7b",
  );
  await expect(
    page.getByLabel("DREAM STRENGTH exact value", { exact: true }),
  ).toHaveValue("0.37");
  await expect(page.getByLabel("DREAM GUIDANCE", { exact: true })).toHaveValue(
    "off",
  );
  await expect(page.locator(".neuron-selected-preview figcaption")).toHaveText(
    "mixed_7b · Channel #2047",
  );
  expect(await field(page)).toEqual(before);
  await page.locator("#toggle-animation").click();
  await page
    .getByRole("button", { name: "Browse neuron previews", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__previewRuntime.steps))
    .toBeGreaterThan(before.steps);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#toggle-animation")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator("#toggle-animation").click();
});

test("obsolete previews stay hidden and failed previews offer a working retry", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installPreviewFixture(page);
  await openGrowth(page);
  await page
    .getByRole("button", { name: "Manual Channel Explorer", exact: true })
    .click();
  const channel = page.getByLabel("DREAM NEURON exact value", { exact: true });
  await page.evaluate(() => {
    window.__slowChannel = 21;
  });
  await channel.fill("21");
  await page
    .getByRole("button", { name: "Preview selected neuron", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__previewCalls?.includes("mixed_6c_21")),
    )
    .toBe(true);
  await channel.fill("22");
  const image = page.locator(".neuron-selected-preview img");
  await expect(image).toBeHidden();
  await page
    .getByRole("button", { name: "Preview selected neuron", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__previewBridge.previewCache.has("mixed_6c_22"),
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(() =>
      window.__previewBridge.previewCache.has("mixed_6c_21"),
    ),
  ).toBe(false);
  await expect(image).toHaveAttribute(
    "src",
    await page.evaluate(() => window.__previewResults.mixed_6c_22),
  );
  await page.evaluate(() => {
    window.__failChannel = 23;
  });
  await channel.fill("23");
  await page
    .getByRole("button", { name: "Preview selected neuron", exact: true })
    .click();
  const retry = page.getByRole("button", {
    name: "Retry neuron preview",
    exact: true,
  });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(retry).toBeHidden();
  await expect(image).toHaveAttribute(
    "src",
    await page.evaluate(() => window.__previewResults.mixed_6c_23),
  );
  expect(
    await page.evaluate(
      () => window.__previewCalls.filter((key) => key === "mixed_6c_23").length,
    ),
  ).toBe(2);
  expect(errors).toEqual([]);
});

test("bundled Fourier previews render without downloading Inception weights", async ({
  page,
}) => {
  const weights = [];
  page.on("request", (request) => {
    if (/models\/inception\/.*\.bin/.test(request.url()))
      weights.push(request.url());
  });
  await openGrowth(page);
  await expect(
    page.locator(".neuron-gallery__card img:not([hidden])"),
  ).toHaveCount(7);
  await page
    .getByRole("button", { name: "Browse neuron previews", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Neuron explorer",
    exact: true,
  });
  await expect(dialog.locator(".neuron-explorer__card")).toHaveCount(7);
  await expect(dialog.locator(".neuron-explorer__layer-heading")).toHaveText([
    "Earlier layers",
    "Middle layers",
    "Later layers",
  ]);
  const overflows = await dialog
    .locator(".neuron-explorer__card")
    .evaluateAll((cards) =>
      cards.map((card) => card.scrollHeight > card.clientHeight + 1),
    );
  expect(overflows).toEqual(overflows.map(() => false));
  await page.keyboard.press("Escape");
  for (const id of ["curve", "semantic", "hatch"]) {
    await page.locator(`[data-neuron-id="${id}"]`).click();
    const image = page.locator(".neuron-selected-preview img");
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute(
      "src",
      /models\/inception\/previews\/mixed_[567][a-e]-\d+\.webp$/,
    );
    await image.evaluate((element) => element.decode());
  }
  expect(weights).toEqual([]);
});

async function generateManualPreview(page, channel) {
  const manual = page.getByRole("button", {
    name: "Manual Channel Explorer",
    exact: true,
  });
  if ((await manual.getAttribute("aria-expanded")) !== "true")
    await manual.click();
  await page
    .getByLabel("DREAM NEURON exact value", { exact: true })
    .fill(String(channel));
  await page
    .getByRole("button", { name: "Preview selected neuron", exact: true })
    .click();
  await expect(page.locator(".neuron-selected-preview img")).toBeVisible();
  await expect(page.locator(".neuron-selected-preview figcaption")).toHaveText(
    `mixed_6c · Channel #${channel}`,
  );
}

async function browsePreviews(page) {
  await page
    .getByRole("button", { name: "Browse neuron previews", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Neuron explorer", exact: true });
}

test("saved neuron previews survive reload, respect opt-out, and can be cleared", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const weights = [];
  page.on("request", (request) => {
    if (/models\/inception\/.*\.bin/.test(request.url()))
      weights.push(request.url());
  });
  await installPreviewFixture(page, { bundled: true });
  await openGrowth(page);
  await generateManualPreview(page, 501);
  const original = await page
    .locator(".neuron-selected-preview img")
    .getAttribute("src");
  let dialog = await browsePreviews(page);
  await expect(dialog.getByLabel("Save previews on this device")).toBeChecked();
  await expect(
    dialog.locator(".neuron-explorer__cache [role=status]"),
  ).toContainText("1 saved");

  await page.reload();
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
  await installPreviewFixture(page, { bundled: true });
  // Reusing a preview must work even when generation/model loading is unavailable.
  await page.evaluate(async () => {
    const { DreamGuidanceBridge } =
      await import("/assets/js/models/neural-growth/dream-guidance.js");
    DreamGuidanceBridge.prototype.ensureModel = async () => {
      throw new Error("Unexpected Inception load");
    };
  });
  await openGrowth(page);
  dialog = await browsePreviews(page);
  const card = dialog.locator('[data-layer="mixed_6c"][data-channel="501"]');
  await expect(card.locator("img")).toHaveAttribute("src", original);
  await card.locator("img").evaluate((image) => image.decode());
  await card.click();
  await dialog
    .getByRole("button", { name: "Use as Dream target", exact: true })
    .click();
  await expect(page.locator(".neuron-selected-preview img")).toHaveAttribute(
    "src",
    original,
  );
  expect(await page.evaluate(() => window.__previewCalls || [])).toEqual([]);
  dialog = await browsePreviews(page);
  await dialog.getByLabel("Save previews on this device").uncheck();

  await page.reload();
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
  await installPreviewFixture(page, { bundled: true });
  await openGrowth(page);
  dialog = await browsePreviews(page);
  await expect(
    dialog.getByLabel("Save previews on this device"),
  ).not.toBeChecked();
  await expect(dialog.locator(".neuron-explorer__card")).toHaveCount(7);
  await page.keyboard.press("Escape");
  await generateManualPreview(page, 502);
  dialog = await browsePreviews(page);
  await dialog.getByLabel("Save previews on this device").check();
  await expect(
    dialog.locator(".neuron-explorer__cache [role=status]"),
  ).toContainText("2 saved");
  await dialog
    .getByRole("button", { name: "Clear saved previews", exact: true })
    .click();
  await expect(
    dialog.locator(".neuron-explorer__cache [role=status]"),
  ).toContainText("cleared");

  await page.reload();
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
  await installPreviewFixture(page, { bundled: true });
  await openGrowth(page);
  dialog = await browsePreviews(page);
  await expect(dialog.getByLabel("Save previews on this device")).toBeChecked();
  await expect(dialog.locator(".neuron-explorer__card")).toHaveCount(7);
  await expect(
    dialog.locator(".neuron-explorer__cache [role=status]"),
  ).toContainText("0 saved");
  expect(weights).toEqual([]);
});

test("stem channels use exact bounds and saved previews survive reload", async ({
  page,
}) => {
  await installPreviewFixture(page, { bundled: true });
  await openGrowth(page);
  await page
    .getByRole("button", { name: "Manual Channel Explorer", exact: true })
    .click();
  const layer = page.getByLabel("DREAM LAYER", { exact: true });
  const channel = page.getByLabel("DREAM NEURON exact value", { exact: true });
  for (const [name, lastChannel] of [
    ["Conv2d_4a_3x3", 191],
    ["Conv2d_3b_1x1", 79],
    ["Conv2d_2b_3x3", 63],
  ]) {
    await layer.selectOption(name);
    await expect(channel).toHaveAttribute("max", String(lastChannel));
    await channel.fill(String(lastChannel));
  }
  await page
    .getByRole("button", { name: "Preview selected neuron", exact: true })
    .click();
  const image = page.locator(".neuron-selected-preview img");
  await expect(image).toBeVisible();
  const original = await image.getAttribute("src");
  const dialog = await browsePreviews(page);
  await expect(
    dialog.locator(".neuron-explorer__cache [role=status]"),
  ).toContainText("1 saved");
  await page.reload();
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
  await installPreviewFixture(page, { bundled: true });
  await openGrowth(page);
  const restored = await browsePreviews(page);
  await expect(
    restored.locator(".neuron-explorer__layer-heading"),
  ).toContainText(["Stem layers"]);
  await expect(
    restored.locator('[data-layer="Conv2d_2b_3x3"][data-channel="63"] img'),
  ).toHaveAttribute("src", original);
  expect(await page.evaluate(() => window.__previewCalls || [])).toEqual([]);
});

test("clearing saved previews also fences saves from generation already in flight", async ({
  page,
}) => {
  await installPreviewFixture(page);
  await openGrowth(page);
  await generateManualPreview(page, 501);
  await page.evaluate(() => {
    window.__slowChannel = 502;
  });
  await page
    .getByLabel("DREAM NEURON exact value", { exact: true })
    .fill("502");
  await page
    .getByRole("button", { name: "Preview selected neuron", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__previewCalls?.includes("mixed_6c_502")),
    )
    .toBe(true);
  const dialog = await browsePreviews(page);
  await dialog
    .getByRole("button", { name: "Clear saved previews", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__previewBridge.previewCache.has("mixed_6c_502"),
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () => window.__previewBridge.previewStorage.status.count,
    ),
  ).toBe(0);
  await page.reload();
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
  await installPreviewFixture(page);
  await openGrowth(page);
  await browsePreviews(page);
  await expect(page.locator(".neuron-explorer__card")).toHaveCount(0);
});

test("persistent previews evict least recently used records and reject stale or malformed data", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { NeuronPreviewCache } =
      await import("/assets/js/models/neural-growth/neuron-preview-cache.js");
    const { previewSeed } =
      await import("/assets/js/models/neural-growth/neuron-preview.js");
    const cache = new NeuronPreviewCache({ maxEntries: 192 });
    const url = document.createElement("canvas").toDataURL("image/webp");
    await cache.load("checkpoint-and-recipe-a");
    for (let channel = 0; channel < 193; channel++)
      await cache.save(
        `mixed_6c_${channel}`,
        url,
        previewSeed("mixed_6c", channel),
      );
    const evicted = await cache.load("checkpoint-and-recipe-a");
    await cache.save("mixed_6c_1", url, previewSeed("mixed_6c", 1));
    await cache.save("mixed_6c_193", url, previewSeed("mixed_6c", 193));
    const touched = await cache.load("checkpoint-and-recipe-a");
    // Simulate bad data from an older version of the app.
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("latent-field-neuron-previews", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction("previews", "readwrite");
    const done = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
    });
    const store = transaction.objectStore("previews");
    store.put({
      key: "mixed_6c_500",
      namespace: "checkpoint-and-recipe-a",
      seed: previewSeed("mixed_6c", 500),
      url: "javascript:alert(1)",
      usedAt: Date.now(),
    });
    store.put({
      key: "mixed_6c_501",
      namespace: "checkpoint-and-recipe-a",
      seed: 0,
      url,
      usedAt: Date.now(),
    });
    await done;
    db.close();
    const cleaned = await cache.load("checkpoint-and-recipe-a");
    const invalidated = await cache.load("checkpoint-or-recipe-b");
    const keys = (records) => records.map((record) => record.key);
    cache.dispose();
    return {
      evicted: keys(evicted),
      touched: keys(touched),
      cleaned: keys(cleaned),
      invalidated: keys(invalidated),
    };
  });
  expect(result.evicted).toHaveLength(192);
  expect(result.evicted).not.toContain("mixed_6c_0");
  expect(result.touched).toContain("mixed_6c_1");
  expect(result.touched).not.toContain("mixed_6c_2");
  expect(result.cleaned).toHaveLength(192);
  expect(result.cleaned).not.toContain("mixed_6c_500");
  expect(result.cleaned).not.toContain("mixed_6c_501");
  expect(result.invalidated).toEqual([]);
});

test("restricted storage and quota failures keep session previews usable", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installPreviewFixture(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    window.__restorePreviewStorage = () => {
      IDBObjectStore.prototype.put = put;
    };
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "previews")
        throw new DOMException("Storage full", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  await openGrowth(page);
  await generateManualPreview(page, 501);
  let dialog = await browsePreviews(page);
  await expect(
    dialog.locator(".neuron-explorer__cache [role=status]"),
  ).toContainText("Saving unavailable");
  expect(
    await page.evaluate(() =>
      window.__previewBridge.previewCache.has("mixed_6c_501"),
    ),
  ).toBe(true);
  await page.evaluate(() => window.__restorePreviewStorage());
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
  await installPreviewFixture(page);
  await page.evaluate(() => {
    Object.defineProperty(window, "indexedDB", {
      get() {
        throw new DOMException("Storage blocked", "SecurityError");
      },
    });
  });
  await openGrowth(page);
  await generateManualPreview(page, 502);
  dialog = await browsePreviews(page);
  await expect(
    dialog.locator(".neuron-explorer__cache [role=status]"),
  ).toContainText("Saving unavailable");
  expect(errors).toEqual([]);
});

test("browsing, inspecting, favorites and restored filters never generate without a click", async ({
  page,
}) => {
  const weights = [];
  page.on("request", (request) => {
    if (/models\/inception\/.*\.bin/.test(request.url()))
      weights.push(request.url());
  });
  await installPreviewFixture(page, { bundled: true });
  await openGrowth(page);
  await page
    .getByRole("button", { name: "Manual Channel Explorer", exact: true })
    .click();
  await page
    .getByLabel("DREAM NEURON exact value", { exact: true })
    .fill("400");
  const before = await field(page);
  let dialog = await browsePreviews(page);
  await dialog.getByLabel("Preview collection").selectOption("all");
  await dialog.getByLabel("Explorer layer").selectOption("mixed_7b");
  await dialog.getByLabel("Find neuron channel").fill("1000");
  const card = dialog.locator('.neuron-explorer__card[data-channel="1000"]');
  await expect(card).toBeVisible();
  await card.click();
  await expect(dialog.locator(".neuron-explorer__detail img")).toBeHidden();
  await expect(
    dialog.getByRole("button", {
      name: "Generate neuron preview",
      exact: true,
    }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Save neuron favorite", exact: true })
    .click();
  await dialog.getByLabel("Preview collection").selectOption("favorites");
  await expect(dialog.locator(".neuron-explorer__card")).toHaveCount(1);
  await dialog.getByLabel("Preview collection").selectOption("recent");
  await expect(dialog.locator(".neuron-explorer__card")).toHaveCount(1);
  // Observe beyond the former automatic 250 ms generation debounce.
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => window.__previewCalls || [])).toEqual([]);
  expect(await field(page)).toEqual(before);
  await expect(
    page.getByLabel("DREAM NEURON exact value", { exact: true }),
  ).toHaveValue("400");
  await dialog
    .getByRole("button", { name: "Use as Dream target", exact: true })
    .click();
  await expect(
    page.getByLabel("DREAM NEURON exact value", { exact: true }),
  ).toHaveValue("1000");
  expect(await page.evaluate(() => window.__previewCalls || [])).toEqual([]);
  expect(await field(page)).toEqual(before);

  await page.reload();
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
  await installPreviewFixture(page, { bundled: true });
  await openGrowth(page);
  dialog = await browsePreviews(page);
  await expect(dialog.getByLabel("Explorer layer")).toHaveValue("mixed_7b");
  await expect(dialog.getByLabel("Preview collection")).toHaveValue("recent");
  await expect(dialog.getByLabel("Find neuron channel")).toHaveValue("1000");
  await expect(dialog.locator(".neuron-explorer__card")).toHaveCount(1);
  await expect(
    dialog.getByRole("button", {
      name: "Favorite mixed_7b Channel #1000",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => window.__previewCalls || [])).toEqual([]);
  expect(weights).toEqual([]);
});

test("background ranges span pages, pause for user control, prioritize selected previews, and survive panel closure", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await installPreviewFixture(page);
  await openGrowth(page);
  await page.locator("#step-growth").click();
  const before = await field(page);
  let dialog = await browsePreviews(page);
  await dialog.locator(".neuron-explorer__background > summary").click();
  await dialog.getByLabel("Preview collection").selectOption("all");
  await dialog.getByLabel("Explorer layer").selectOption("mixed_7b");
  await dialog.getByLabel("Background batch scope").selectOption("layer");
  await expect(
    dialog.getByText("2049 uncached previews", { exact: true }),
  ).toBeVisible();
  await dialog.getByLabel("Explorer layer").selectOption("mixed_5b");
  await dialog.getByLabel("Background batch scope").selectOption("range");
  await dialog.getByLabel("First background channel").fill("0");
  await dialog.getByLabel("Last background channel").fill("23");
  await expect(
    dialog.getByText("24 uncached previews", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__previewCalls || [])).toEqual([]);
  await page.evaluate(() => {
    window.__slowChannel = 0;
  });
  await dialog
    .getByRole("button", { name: "Start background cache", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__previewCalls?.includes("mixed_5b_0")),
    )
    .toBe(true);
  await dialog
    .getByRole("button", { name: "Pause background cache", exact: true })
    .click();
  await expect(
    dialog.locator(".neuron-explorer__background [role=status]"),
  ).toContainText("paused");
  await page.keyboard.press("Escape");
  const compact = page.locator(".neuron-background-progress");
  await expect(compact).toBeVisible();
  await generateManualPreview(page, 31);
  expect(
    await page.evaluate(
      () => window.__previewBridge.backgroundPreviewStatus.phase,
    ),
  ).toBe("paused");
  expect(
    await page.evaluate(
      () => window.__previewBridge.backgroundPreviewStatus.completed,
    ),
  ).toBe(0);
  expect(await field(page)).toEqual(before);
  await page.locator("#toggle-animation").click();
  await compact
    .getByRole("button", { name: "Resume background cache", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__previewRuntime.steps))
    .toBeGreaterThan(before.steps);
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__previewBridge.backgroundPreviewStatus.completed,
      ),
    )
    .toBeGreaterThan(0);
  // Software WebGL is deliberately slow; verify concurrent progress, then let
  // the remaining batch finish without requiring a hardware-specific deadline.
  await page.locator("#toggle-animation").click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.__previewBridge.backgroundPreviewStatus.phase,
        ),
      { timeout: 30_000 },
    )
    .toBe("complete");
  expect(
    await page.evaluate(
      () => window.__previewBridge.backgroundPreviewStatus.completed,
    ),
  ).toBe(24);
  expect(
    await page.evaluate(
      () => window.__previewBridge.previewStorage.status.count,
    ),
  ).toBe(25);
  await expect(compact).toBeHidden();

  await page.reload();
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
  await installPreviewFixture(page);
  await openGrowth(page);
  dialog = await browsePreviews(page);
  await expect(dialog.getByLabel("Background batch scope")).toHaveValue(
    "range",
  );
  await expect(dialog.getByLabel("Last background channel")).toHaveValue("23");
  await expect(
    dialog.getByText("0 uncached previews", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Start background cache", exact: true }),
  ).toBeDisabled();
  expect(await page.evaluate(() => window.__previewCalls || [])).toEqual([]);
  expect(
    await page.evaluate(
      () => window.__previewBridge.backgroundPreviewStatus.phase,
    ),
  ).toBe("idle");
});

test("cancelling or clearing a background batch prevents further generation and persistence", async ({
  page,
}) => {
  await installPreviewFixture(page);
  await openGrowth(page);
  const dialog = await browsePreviews(page);
  await dialog.locator(".neuron-explorer__background > summary").click();
  await dialog.getByLabel("Background batch scope").selectOption("range");
  await dialog.getByLabel("First background channel").fill("30");
  await dialog.getByLabel("Last background channel").fill("60");
  await page.evaluate(() => {
    window.__slowChannel = 30;
  });
  await dialog
    .getByRole("button", { name: "Start background cache", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__previewCalls?.includes("mixed_6c_30")),
    )
    .toBe(true);
  await dialog
    .getByRole("button", { name: "Cancel background cache", exact: true })
    .click();
  await page.evaluate(async () => {
    await window.__previewBridge._backgroundPreviewJob.task;
    await window.__previewBridge._previewTask;
  });
  expect(await page.evaluate(() => window.__previewCalls)).toEqual([
    "mixed_6c_30",
  ]);
  expect(
    await page.evaluate(
      () => window.__previewBridge.previewStorage.status.count,
    ),
  ).toBe(0);
  await dialog
    .getByRole("button", { name: "Start background cache", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__previewCalls.length))
    .toBe(2);
  await page.evaluate(() => window.__previewBridge.clearSavedPreviews());
  await page.evaluate(async () => {
    await window.__previewBridge._backgroundPreviewJob.task;
    await window.__previewBridge._previewTask;
  });
  expect(
    await page.evaluate(
      () => window.__previewBridge.backgroundPreviewStatus.phase,
    ),
  ).toBe("cancelled");
  expect(
    await page.evaluate(
      () => window.__previewBridge.previewStorage.status.count,
    ),
  ).toBe(0);
  expect(await page.evaluate(() => window.__previewCalls)).toEqual([
    "mixed_6c_30",
    "mixed_6c_30",
  ]);
  await expect(
    dialog.getByRole("button", { name: "Start background cache", exact: true }),
  ).toBeEnabled();
});
