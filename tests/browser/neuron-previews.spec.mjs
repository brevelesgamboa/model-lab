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
      await import("/assets/js/models/neural-growth/neuron-preview-provider.js");
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
    const { NeuronPreviewProvider } =
      await import("/assets/js/models/neural-growth/neuron-preview-provider.js");
    const { InceptionDreamModel } =
      await import("/assets/js/models/inception-dream.js");
    const render = InceptionDreamModel.prototype.render;
    InceptionDreamModel.prototype.render = function (...args) {
      window.__previewOwner = this;
      return render.apply(this, args);
    };
    const loadBundled = NeuronPreviewProvider.prototype.loadBundledPreviews;
    NeuronPreviewProvider.prototype.loadBundledPreviews = async function () {
      window.__previewBridge = this;
      if (useBundled) return loadBundled.call(this);
      this._previewNamespace = "fixture-checkpoint:fourier-v2:96:96";
      return this.previewCache;
    };
    NeuronPreviewProvider.prototype.ensureModel = async function () {
      return {};
    };
    const start = NeuronPreviewProvider.prototype._startPreviewQueue;
    NeuronPreviewProvider.prototype._startPreviewQueue = function () {
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

async function openDream(page) {
  await page.locator("#model-select").selectOption("inception-dream");
  await expect(page.locator("#neural-dream-tools")).toBeVisible();
  await expect(page.locator(".neuron-gallery")).toBeVisible();
}

async function field(page) {
  return page.evaluate(() => ({
    steps: window.__previewOwner.totalSteps,
    image: document.getElementById("output-canvas").toDataURL(),
    parameters: [
      ...document.querySelectorAll(
        "#parameter-controls input, #parameter-controls select",
      ),
    ].map((input) => [input.getAttribute("aria-label"), input.value]),
  }));
}

test("obsolete previews stay hidden and failed previews offer a working retry", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installPreviewFixture(page);
  await openDream(page);
  await page.evaluate(() => {
    window.__slowChannel = 21;
  });
  let dialog = await inspectPreview(page, 21);
  await dialog
    .getByRole("button", { name: "Generate neuron preview", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__previewCalls?.includes("mixed_6c_21")),
    )
    .toBe(true);
  dialog = await inspectPreview(page, 22);
  const image = dialog.locator(".neuron-explorer__detail img");
  await expect(image).toBeHidden();
  await dialog
    .getByRole("button", { name: "Generate neuron preview", exact: true })
    .click();
  await expect(image).toHaveAttribute("src", /data:image\/webp/);
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
  dialog = await inspectPreview(page, 23);
  await dialog
    .getByRole("button", { name: "Generate neuron preview", exact: true })
    .click();
  const retry = dialog.getByRole("button", {
    name: "Retry neuron detail preview",
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
  await openDream(page);
  const dialog = await browsePreviews(page);
  await showAvailablePreviews(dialog);
  await expect(
    dialog.locator(".neuron-explorer__card img:not([hidden])"),
  ).toHaveCount(7);
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
  for (const [layer, channel] of [
    ["mixed_6c", 144],
    ["mixed_7b", 312],
    ["mixed_5b", 120],
  ]) {
    await inspectPreview(page, channel, layer);
    const image = dialog.locator(".neuron-explorer__detail img");
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute(
      "src",
      /models\/inception\/previews\/mixed_[567][a-e]-\d+\.webp$/,
    );
    await image.evaluate((element) => element.decode());
  }
  expect(weights).toEqual([]);
});

async function browsePreviews(page) {
  const dialog = page.getByRole("dialog", {
    name: "Neuron explorer",
    exact: true,
  });
  if (!(await dialog.isVisible())) {
    await page
      .getByRole("button", { name: "Browse neuron previews", exact: true })
      .click();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.locator(".neuron-explorer__pagination [role=status]"),
    ).not.toBeEmpty();
  }
  return dialog;
}

async function inspectPreview(page, channel, layer = "mixed_6c") {
  const dialog = await browsePreviews(page);
  await dialog.getByLabel("Preview collection").selectOption("all");
  await dialog.getByLabel("Explorer layer").selectOption(layer);
  await dialog.getByLabel("Find neuron channel").fill(String(channel));
  const card = dialog.locator(
    '.neuron-explorer__card[data-channel="' + channel + '"]',
  );
  await expect(card).toHaveCount(1);
  await card.click();
  await expect(dialog.locator(".neuron-explorer__detail h3")).toContainText(
    layer + " · Channel #" + channel,
  );
  return dialog;
}

async function generateManualPreview(page, channel, layer = "mixed_6c") {
  const dialog = await inspectPreview(page, channel, layer);
  const generate = dialog.getByRole("button", {
    name: "Generate neuron preview",
    exact: true,
  });
  if (await generate.isVisible()) await generate.click();
  const image = dialog.locator(".neuron-explorer__detail img");
  await expect(image).toBeVisible();
  const url = await image.getAttribute("src");
  await dialog
    .getByRole("button", { name: "Close neuron explorer", exact: true })
    .click();
  return url;
}

async function showAvailablePreviews(dialog) {
  await dialog.getByLabel("Preview collection").selectOption("available");
  await dialog.getByLabel("Explorer layer").selectOption("all");
  await dialog.getByLabel("Find neuron channel").fill("");
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
  await openDream(page);
  const original = await generateManualPreview(page, 501);
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
    const { NeuronPreviewProvider } =
      await import("/assets/js/models/neural-growth/neuron-preview-provider.js");
    NeuronPreviewProvider.prototype.ensureModel = async () => {
      throw new Error("Unexpected Inception load");
    };
  });
  await openDream(page);
  dialog = await browsePreviews(page);
  const card = dialog.locator('[data-layer="mixed_6c"][data-channel="501"]');
  await expect(card.locator("img")).toHaveAttribute("src", original);
  await card.locator("img").evaluate((image) => image.decode());
  await card.click();
  await dialog
    .getByRole("button", { name: "Close neuron explorer", exact: true })
    .click();
  dialog = await inspectPreview(page, 501);
  await expect(dialog.locator(".neuron-explorer__detail img")).toHaveAttribute(
    "src",
    original,
  );
  expect(await page.evaluate(() => window.__previewCalls || [])).toEqual([]);
  dialog = await browsePreviews(page);
  await dialog.getByLabel("Save previews on this device").uncheck();

  await page.reload();
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
  await installPreviewFixture(page, { bundled: true });
  await openDream(page);
  dialog = await browsePreviews(page);
  await expect(
    dialog.getByLabel("Save previews on this device"),
  ).not.toBeChecked();
  await showAvailablePreviews(dialog);
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
  await openDream(page);
  dialog = await browsePreviews(page);
  await expect(dialog.getByLabel("Save previews on this device")).toBeChecked();
  await showAvailablePreviews(dialog);
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
  await openDream(page);
  for (const [name, lastChannel] of [
    ["Conv2d_4a_3x3", 191],
    ["Conv2d_3b_1x1", 79],
    ["Conv2d_2b_3x3", 63],
  ]) {
    const dialog = await inspectPreview(page, lastChannel, name);
    await expect(
      dialog.getByLabel("Explorer layer").locator(`option[value="${name}"]`),
    ).toContainText(`${lastChannel + 1} channels`);
    await expect(dialog.getByLabel("Find neuron channel")).toHaveValue(
      String(lastChannel),
    );
    await dialog
      .getByRole("button", { name: "Close neuron explorer", exact: true })
      .click();
  }
  const original = await generateManualPreview(page, 63, "Conv2d_2b_3x3");
  const dialog = await browsePreviews(page);
  await expect(
    dialog.locator(".neuron-explorer__cache [role=status]"),
  ).toContainText("1 saved");
  await page.reload();
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
  await installPreviewFixture(page, { bundled: true });
  await openDream(page);
  const restored = await browsePreviews(page);
  await showAvailablePreviews(restored);
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
  await openDream(page);
  await generateManualPreview(page, 501);
  await page.evaluate(() => {
    window.__slowChannel = 502;
  });
  const pendingDialog = await inspectPreview(page, 502);
  await pendingDialog
    .getByRole("button", { name: "Generate neuron preview", exact: true })
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
  await openDream(page);
  const restored = await browsePreviews(page);
  await showAvailablePreviews(restored);
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
  await openDream(page);
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
  await openDream(page);
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
  await openDream(page);
  const initialDialog = await inspectPreview(page, 400);
  await initialDialog
    .getByRole("button", { name: "Close neuron explorer", exact: true })
    .click();
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
  await dialog
    .getByRole("button", { name: "Close neuron explorer", exact: true })
    .click();
  expect(await page.evaluate(() => window.__previewCalls || [])).toEqual([]);
  expect(await field(page)).toEqual(before);

  await page.reload();
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
  await installPreviewFixture(page, { bundled: true });
  await openDream(page);
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
  await openDream(page);
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
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".neuron-background-progress")).not.toBeAttached();
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
  dialog = await browsePreviews(page);
  await dialog.getByLabel("Explorer layer").selectOption("mixed_5b");
  await dialog.getByLabel("Find neuron channel").fill("");
  await dialog
    .getByRole("button", { name: "Resume background cache", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Close neuron explorer", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__previewBridge.backgroundPreviewStatus.completed,
      ),
    )
    .toBeGreaterThan(0);
  // Software WebGL is deliberately slow; verify concurrent progress, then let
  // the remaining batch finish without requiring a hardware-specific deadline.
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
  await expect(dialog).not.toBeVisible();

  await page.reload();
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
  await installPreviewFixture(page);
  await openDream(page);
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
  await openDream(page);
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

test("standalone Dream gallery previews channels without altering image or ascent settings", async ({
  page,
}) => {
  await installPreviewFixture(page);
  await openDream(page);
  const before = await field(page);
  let dialog = await inspectPreview(page, 1800, "mixed_7b");
  await expect(
    dialog.getByRole("button", { name: "Use as Dream target", exact: true }),
  ).toBeHidden();
  await dialog
    .getByRole("button", { name: "Generate neuron preview", exact: true })
    .click();
  const image = dialog.locator(".neuron-explorer__detail img");
  await expect(image).toBeVisible();
  const url = await image.getAttribute("src");
  await dialog
    .getByRole("button", { name: "Close neuron explorer", exact: true })
    .click();
  dialog = await inspectPreview(page, 1800, "mixed_7b");
  await expect(dialog.locator(".neuron-explorer__detail img")).toHaveAttribute(
    "src",
    url,
  );
  expect(await page.evaluate(() => window.__previewCalls)).toEqual([
    "mixed_7b_1800",
  ]);
  for (const width of [360, 900, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
  }
  expect(await field(page)).toEqual(before);
});
