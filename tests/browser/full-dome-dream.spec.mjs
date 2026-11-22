import { test, expect } from "@playwright/test";

async function open(page) {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto("/");
  await page.evaluate(async () => {
    const { CorticalDreamDomeModel } =
      await import("/assets/js/models/cortical-dream-dome.js");
    const render = CorticalDreamDomeModel.prototype.render;
    CorticalDreamDomeModel.prototype.render = function (...args) {
      window.__dome = this;
      return render.apply(this, args);
    };
  });
  await page.locator("#model-select").selectOption("cortical-dream-dome");
  await page.waitForFunction(() => Boolean(window.__dome?.graphics));
}
async function fixturePhoto(page) {
  const encoded = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 96;
    c.height = 64;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#35789a";
    ctx.fillRect(0, 0, 96, 64);
    ctx.fillStyle = "#e9a456";
    ctx.fillRect(24, 12, 48, 40);
    return c.toDataURL().split(",")[1];
  });
  return {
    name: "dome-photo.png",
    mimeType: "image/png",
    buffer: Buffer.from(encoded, "base64"),
  };
}
async function stubMaps(context) {
  await context.route("**/depth-estimator.worker.js", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: `self.onmessage=({data:{bitmap}})=>{bitmap.close();self.postMessage({type:'result',width:2,height:2,depth:new Float32Array([0,1,.2,.8]),backend:'fixture',inferenceMs:1});};`,
    }),
  );
  await context.route("**/inception-feature-map.worker.js", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: `self.onmessage=({data:{bitmap}})=>{bitmap.close();self.postMessage({type:'result',width:2,height:2,values:new Float32Array([0,.2,.7,1]),backend:'fixture',inferenceMs:1,retainedTensors:0});};`,
    }),
  );
}

test("360 synthesis starts manually, gates camera, shows progress, cancels safely and retains the panorama on context restoration", async ({
  page,
  context,
}) => {
  await stubMaps(context);
  await context.route("**/inception-dream-bake.worker.js", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: `self.onmessage=({data:{bitmap,iterations}})=>{
    const c=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
    const rgba=ctx.getImageData(0,0,c.width,c.height).data;
    self.postMessage({type:'progress',percent:40});
    setTimeout(()=>self.postMessage({type:'result',rgba,width:c.width,height:c.height,iterations,bakeMs:1500,retainedTensors:0,backend:'fixture'},[rgba.buffer]),1500);
  };`,
    }),
  );
  await open(page);
  await expect(page.locator("#dome-generate")).toBeDisabled();
  await page.locator("#dome-image").setInputFiles(await fixturePhoto(page));
  await expect(page.locator("#dome-generate")).toBeEnabled();
  expect(await page.evaluate(() => window.__dome.baker.runs)).toBe(0);
  await page.evaluate(() => {
    window.__seedPanorama = window.__dome.panorama;
  });
  await page.locator("#dome-generate").click();
  await expect(page.locator("#dome-bake-overlay")).toBeVisible();
  await expect(page.locator("#dome-bake-label")).toContainText("40%");
  await expect(page.locator("#dome-reset-view")).toBeDisabled();
  const yaw = await page.evaluate(() => window.__dome.camera.yaw);
  await page.locator("#output-canvas").focus();
  await page.keyboard.press("ArrowRight");
  expect(await page.evaluate(() => window.__dome.camera.yaw)).toBe(yaw);
  await page.locator("#dome-cancel-bake").click();
  await expect(page.locator("#dome-bake-overlay")).toBeHidden();
  expect(
    await page.evaluate(() => window.__dome.panorama === window.__seedPanorama),
  ).toBe(true);
  await page.locator("#dome-generate").click();
  await expect
    .poll(() => page.evaluate(() => window.__dome.bakeState))
    .toBe("ready");
  await expect(page.locator("#dome-reset-view")).toBeEnabled();
  const result = await page.evaluate(() => {
    const d = window.__dome,
      rgba = d.panorama.getContext("2d").getImageData(0, 0, 1024, 512).data;
    window.__bakedPanorama = d.panorama;
    return {
      runs: d.baker.runs,
      worker: !!d.baker.pending,
      center: [
        ...rgba.slice((256 * 1024 + 512) * 4, (256 * 1024 + 512) * 4 + 4),
      ],
      gl: d.gl.getError(),
    };
  });
  expect(result).toMatchObject({
    runs: 2,
    worker: false,
    center: [233, 164, 86, 255],
    gl: 0,
  });
  await page.evaluate(() => {
    window.__lost = window.__dome.gl.getExtension("WEBGL_lose_context");
    window.__lost.loseContext();
  });
  await expect
    .poll(() => page.evaluate(() => window.__dome.available))
    .toBe(false);
  await page.evaluate(() => window.__lost.restoreContext());
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__dome.graphics)))
    .toBe(true);
  expect(
    await page.evaluate(
      () => window.__dome.panorama === window.__bakedPanorama,
    ),
  ).toBe(true);
  expect(await page.evaluate(() => window.__dome.baker.runs)).toBe(2);
  await page.locator("#output-canvas").focus();
  await page.keyboard.press("ArrowRight");
  expect(await page.evaluate(() => window.__dome.camera.yaw)).not.toBe(yaw);
});

test("the cache drawer counts actual files, requests persistence only on click and reports a denied request", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    window.__persistRequests = 0;
    Object.defineProperty(navigator, "storage", {
      value: {
        persisted: async () => false,
        persist: async () => {
          window.__persistRequests++;
          return false;
        },
      },
    });
  });
  await open(page);
  await page.locator("#model-cache-drawer summary").click();
  await expect(page.locator("#model-cache-inception")).toContainText(
    "Incomplete",
  );
  expect(await page.evaluate(() => window.__persistRequests)).toBe(0);
  // A denied request may reset the checkbox before check() verifies its state.
  await page.locator("#model-cache-persist").click();
  await expect(page.locator("#model-cache-status")).toContainText(
    "did not grant",
  );
  await expect(page.locator("#model-cache-persist")).not.toBeChecked();
  expect(await page.evaluate(() => window.__persistRequests)).toBe(1);
  await page.evaluate(() => {
    navigator.storage.persisted = async () => window.__persistRequests >= 2;
    navigator.storage.persist = async () => {
      window.__persistRequests++;
      return true;
    };
  });
  await page.locator("#model-cache-persist").check();
  await expect(page.locator("#model-cache-persist")).toBeChecked();
  await expect(page.locator("#model-cache-persist")).toBeDisabled();
  await page.evaluate(async () => {
    const { MODEL_CACHE_NAME, INCEPTION_MODEL_URL, DEPTH_MODEL_URLS } =
      await import("/assets/js/core/local-model-cache.js");
    const cache = await caches.open(MODEL_CACHE_NAME);
    await cache.put(
      INCEPTION_MODEL_URL,
      new Response(
        JSON.stringify({ weightsManifest: [{ paths: ["fixture.bin"] }] }),
      ),
    );
    await cache.put(
      new URL("fixture.bin", INCEPTION_MODEL_URL),
      new Response("weights"),
    );
    for (const url of DEPTH_MODEL_URLS)
      await cache.put(url, new Response("fixture"));
  });
  await page.locator("#model-cache-drawer summary").click();
  await page.locator("#model-cache-drawer summary").click();
  await expect(page.locator("#model-cache-inception")).toContainText(
    "Cached · 2/2",
  );
  await expect(page.locator("#model-cache-depth")).toContainText(
    "Cached · 2/2",
  );
});

test("a real backward bake generates a wrapped field, protects the photo and leaves no tensors or main-thread TF", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { create360Canvas, photoProtection } =
      await import("/assets/js/models/equirectangular-canvas.js");
    const { DomeDreamBaker } =
      await import("/assets/js/models/inception-dream-bake.js");
    const photo = new OffscreenCanvas(96, 64),
      ctx = photo.getContext("2d");
    ctx.fillStyle = "#458090";
    ctx.fillRect(0, 0, 96, 64);
    ctx.fillStyle = "#e9a456";
    ctx.fillRect(24, 12, 48, 40);
    const seed = create360Canvas(photo, 256, 128),
      original = seed.getContext("2d").getImageData(0, 0, 256, 128).data;
    const baker = new DomeDreamBaker(),
      progress = [];
    const out = await baker.bake(seed, "mixed_5b", 120, 2, {
      onProgress: (n) => progress.push(n),
    });
    let protectedError = 0,
      rearChange = 0,
      wrapMax = 0;
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 256; x++)
        for (let c = 0; c < 3; c++) {
          const i = (y * 256 + x) * 4 + c;
          if (photoProtection(x, y, seed.photoRect) === 1)
            protectedError = Math.max(
              protectedError,
              Math.abs(out.rgba[i] - original[i]),
            );
          if (x < 32) rearChange += Math.abs(out.rgba[i] - original[i]);
          if (x === 0)
            wrapMax = Math.max(
              wrapMax,
              Math.abs(out.rgba[i] - out.rgba[(y * 256 + 255) * 4 + c]),
            );
        }
    const { inspectModelCache } =
      await import("/assets/js/core/local-model-cache.js");
    return {
      protectedError,
      rearChange,
      wrapMax,
      progress,
      retained: out.retainedTensors,
      iterations: out.iterations,
      pending: !!baker.pending,
      cache: await inspectModelCache(),
      mainTf: !!window.tf,
    };
  });
  expect(result.protectedError).toBe(0);
  expect(result.rearChange).toBeGreaterThan(1000);
  expect(result.wrapMax).toBeLessThan(48);
  expect(result.progress).toContain(100);
  expect(result.retained).toBe(0);
  expect(result.iterations).toBe(2);
  expect(result.pending).toBe(false);
  expect(result.mainTf).toBe(false);
  expect(result.cache.inception.ready).toBe(true);
  // A fresh worker must load every model file from Cache Storage, rather than
  // accidentally relying on HTTP cache or a still-resident TF model.
  await page.route("**/models/inception/**", (route) => route.abort());
  const cached = await page.evaluate(async () => {
    const { create360Canvas } =
      await import("/assets/js/models/equirectangular-canvas.js");
    const { DomeDreamBaker } =
      await import("/assets/js/models/inception-dream-bake.js");
    const c = new OffscreenCanvas(96, 64),
      ctx = c.getContext("2d");
    ctx.fillStyle = "#458090";
    ctx.fillRect(0, 0, 96, 64);
    const baker = new DomeDreamBaker();
    const out = await baker.bake(
      create360Canvas(c, 256, 128),
      "mixed_5b",
      120,
      1,
    );
    return { iterations: out.iterations, retained: out.retainedTensors };
  });
  expect(cached).toEqual({ iterations: 1, retained: 0 });
});
