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
        await generateNeuronPreview(model, "mixed_6c", -1),
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

test("gallery receives each in-memory preview once and reuses thumbnails after control/view changes", async ({
  page,
}) => {
  const errors = [];
  const inceptionRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("/models/inception/"))
      inceptionRequests.push(request.url());
  });
  await page.evaluate(async () => {
    const { DreamGuidanceBridge } =
      await import("/assets/js/models/neural-growth/dream-guidance.js");
    const { TextureNcaRuntime } =
      await import("/assets/js/models/neural-growth/runtime.js");
    const draw = TextureNcaRuntime.prototype.draw;
    TextureNcaRuntime.prototype.draw = function (...args) {
      window.__previewRuntime = this;
      return draw.apply(this, args);
    };
    // Exercise production scheduling/cache/UI with fast, deterministic image synthesis.
    // The other test covers the actual Inception gradients and encoding.
    DreamGuidanceBridge.prototype.computeGradient = async function () {
      window.__previewBridge = this;
      window.__previewCalls ??= [];
      this._generatePreview = async (
        _model,
        layer,
        channel,
        size,
        _steps,
        { beforeStep },
      ) => {
        await beforeStep();
        window.__previewCalls.push(`${layer}_${channel}`);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const context = canvas.getContext("2d");
        context.fillStyle = channel < 0 ? "#e1845c" : "#4a96c6";
        context.fillRect(0, 0, size, size);
        return canvas.toDataURL("image/webp", 0.85);
      };
      this.onModelReady({});
      return null;
    };
  });
  await page.locator("#model-select").selectOption("neural-growth");
  await expect(page.locator("#step-growth")).toBeEnabled();
  await expect(page.locator(".neuron-gallery img[hidden]")).toHaveCount(7);
  expect(inceptionRequests).toHaveLength(0);
  await page.locator('[data-neuron-id="curve"]').click();
  await page.getByLabel("DREAM GUIDANCE", { exact: true }).selectOption("on");
  await page.getByLabel("DREAM CADENCE exact value", { exact: true }).fill("1");
  await page.locator("#step-growth").click();
  await expect
    .poll(() => page.evaluate(() => window.__previewBridge?.previewCache.size))
    .toBe(7);
  await expect(page.locator(".neuron-gallery img:not([hidden])")).toHaveCount(
    7,
  );
  const before = await page.evaluate(() => ({
    steps: window.__previewRuntime.getStats().steps,
    state: Array.from(window.__previewRuntime.readState()),
  }));
  const urls = await page
    .locator(".neuron-gallery img")
    .evaluateAll(async (images) => {
      await Promise.all(images.map((image) => image.decode()));
      return images.map((image) => image.src);
    });
  expect(urls.every((url) => url.startsWith("data:image/webp;base64,"))).toBe(
    true,
  );
  await page
    .getByLabel("DREAM LAYER", { exact: true })
    .selectOption("mixed_5b");
  await page.locator('[data-view="about"]').click();
  await page.locator('[data-view="lab"]').click();
  await page.locator("#model-select").selectOption("folded-fractal");
  expect(
    await page.evaluate(() => window.__previewBridge._previewListeners.size),
  ).toBe(0);
  await page.locator("#model-select").selectOption("neural-growth");
  await expect(page.locator("#step-growth")).toBeEnabled();
  expect(
    await page
      .locator(".neuron-gallery img")
      .evaluateAll((images) => images.map((image) => image.src)),
  ).toEqual(urls);
  expect(
    await page.evaluate(() => window.__previewBridge._previewListeners.size),
  ).toBe(1);
  expect(await page.evaluate(() => window.__previewCalls.length)).toBe(7);
  const after = await page.evaluate(() => ({
    steps: window.__previewRuntime.getStats().steps,
    state: Array.from(window.__previewRuntime.readState()),
  }));
  expect(after).toEqual(before);
  expect(
    await page.evaluate(() =>
      Object.values(localStorage).some((value) => value.includes("data:image")),
    ),
  ).toBe(false);
  expect(inceptionRequests).toHaveLength(0);
  await expect(page.locator(".modulation-toggle:visible")).toHaveCount(18);
  expect(errors).toEqual([]);
});
