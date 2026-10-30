import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";

async function open(page, context) {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  for (const file of [
    "depth-estimator.worker.js",
    "inception-feature-map.worker.js",
  ])
    await context.route(`**/${file}`, (r) =>
      r.fulfill({
        contentType: "text/javascript",
        body: `self.onmessage=({data:{bitmap}})=>{bitmap.close();self.postMessage({type:'result',width:2,height:2,depth:new Float32Array([0,1,.2,.8]),values:new Float32Array([0,.2,.8,1]),backend:'fixture',inferenceMs:1});}`,
      }),
    );
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
  await page.waitForFunction(() => !!window.__dome?.graphics);
}
async function upload(page) {
  const encoded = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 96;
    c.height = 64;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#727272";
    ctx.fillRect(0, 0, 96, 64);
    ctx.fillStyle = "#bbb";
    ctx.fillRect(24, 12, 48, 40);
    return c.toDataURL().split(",")[1];
  });
  await page.locator("#dome-image").setInputFiles({
    name: "gray-stone.png",
    mimeType: "image/png",
    buffer: Buffer.from(encoded, "base64"),
  });
  await expect(page.locator("#dome-generate")).toBeEnabled();
}

test("optional model prompt, bad-file fallback, cancellation and late worker results leave mirrored rendering intact", async ({
  page,
  context,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.route("**/migan-inpainter.worker.js", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: `
 self.onmessage=({data})=>{
  if(data.type==='prepare') {
   if(data.file)self.postMessage({type:'error',error:'Invalid model fixture'});
   else setTimeout(()=>self.postMessage({type:'missing'}),200);
  }
 };`,
    }),
  );
  await open(page, context);
  await upload(page);
  expect(await page.evaluate(() => window.__dome.outpaintingMode)).toBe(
    "mirrored",
  );
  await page.locator("#dome-outpainting").selectOption("migan");
  await expect(page.locator("#dome-migan-card")).toBeVisible();
  await expect(page.locator("#dome-generate")).toBeDisabled();
  await expect(page.locator("#dome-generate")).toBeHidden();
  await page.locator("#dome-migan-cancel").click();
  await expect(page.locator("#dome-outpainting")).toHaveValue("mirrored");
  await expect(page.locator("#dome-migan-card")).toBeHidden();
  await expect(page.locator("#dome-generate")).toBeVisible();
  await page.locator("#dome-outpainting").selectOption("migan");
  await expect(page.locator("#dome-migan-card")).toBeVisible();
  await page.locator("#dome-migan-file").setInputFiles({
    name: "invalid.onnx",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("invalid"),
  });
  await expect(page.locator("#dome-migan-notice")).toContainText(
    "Invalid model fixture",
  );
  await expect(page.locator("#dome-outpainting")).toHaveValue("mirrored");
  await page.locator("#dome-outpainting").selectOption("migan");
  await expect(page.locator("#dome-migan-busy")).toBeVisible();
  await page.locator("#dome-migan-cancel").click();
  await page.waitForTimeout(300);
  await expect(page.locator("#dome-migan-card")).toBeHidden();
  await expect(page.locator("#dome-generate")).toBeEnabled();
  expect(
    await page.evaluate(() => [
      window.__dome.outpaintingMode,
      window.__dome.gl.getError(),
    ]),
  ).toEqual(["mirrored", 0]);
  expect(errors).toEqual([]);
});

test("mirrored geometry closes rear and poles and retention lighting keeps grayscale free of colored artifacts", async ({
  page,
  context,
}) => {
  await open(page, context);
  await upload(page);
  const result = await page.evaluate(async () => {
    const d = window.__dome,
      target = document.createElement("canvas");
    target.width = 256;
    target.height = 256;
    const p = Object.fromEntries(d.controls.map((c) => [c.key, c.default]));
    let maxChroma = 0,
      minSum = Infinity;
    for (const [yaw, pitch] of [
      [0, 0],
      [Math.PI, 0],
      [Math.PI - 0.0001, 0],
      [-Math.PI + 0.0001, 0],
      [1, 0.8],
      [-1, -0.8],
    ]) {
      d.camera.yaw = yaw;
      d.camera.pitch = pitch;
      await d.render(target, p, 1.7);
      const pixels = target.getContext("2d").getImageData(0, 0, 256, 256).data;
      for (let i = 0; i < pixels.length; i += 4) {
        maxChroma = Math.max(
          maxChroma,
          Math.max(...pixels.slice(i, i + 3)) -
            Math.min(...pixels.slice(i, i + 3)),
        );
        minSum = Math.min(minSum, pixels[i] + pixels[i + 1] + pixels[i + 2]);
      }
    }
    return { maxChroma, minSum, gl: d.gl.getError() };
  });
  expect(result.maxChroma).toBeLessThanOrEqual(1);
  expect(result.minSum).toBeGreaterThan(0);
  expect(result.gl).toBe(0);
});

const modelPath = "models/inpainting/migan_pipeline_v2.onnx";
test("real MI-GAN file picker compiles, caches bytes and reuses IndexedDB after reload without a local file", async ({
  page,
  context,
}) => {
  test.skip(
    !existsSync(modelPath),
    "Optional official MI-GAN model is not installed.",
  );
  test.setTimeout(180000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let probes = 0;
  await context.route("**/models/inpainting/migan_pipeline_v2.onnx", (r) => {
    probes++;
    return r.fulfill({ status: 404, body: "" });
  });
  await open(page, context);
  await upload(page);
  await page.locator("#dome-outpainting").selectOption("migan");
  await expect(page.locator("#dome-migan-card")).toBeVisible();
  await page
    .locator("#dome-migan-file")
    .setInputFiles({
      name: "invalid.onnx",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("broken protobuf"),
    });
  await expect(page.locator("#dome-outpainting")).toHaveValue("mirrored", {
    timeout: 120000,
  });
  await expect(page.locator("#dome-migan-notice")).toContainText(
    "MI-GAN unavailable",
  );
  await page.locator("#dome-outpainting").selectOption("migan");
  await expect(page.locator("#dome-migan-card")).toBeVisible();
  await page.locator("#dome-migan-file").setInputFiles(modelPath);
  await expect(page.locator("#dome-migan-status")).toContainText(
    "MI-GAN Ready",
    { timeout: 120000 },
  );
  await expect(page.locator("#dome-migan-status")).toContainText("Cached");
  expect(await page.evaluate(() => window.__dome.inpaintInfo.origin)).toBe(
    "Selected file",
  );
  const seed = await page.evaluate(() => {
    const d = window.__dome,
      r = d.photoRect,
      rgba = d.panorama.getContext("2d").getImageData(0, 0, 1024, 512).data;
    let seam = 0;
    for (let y = 0; y < 512; y++)
      for (let c = 0; c < 3; c++)
        seam = Math.max(
          seam,
          Math.abs(rgba[y * 1024 * 4 + c] - rgba[(y * 1024 + 1023) * 4 + c]),
        );
    return {
      mode: d.outpaintingMode,
      seam,
      center: [
        ...rgba.slice((256 * 1024 + 512) * 4, (256 * 1024 + 512) * 4 + 4),
      ],
      rect: !!r,
      gl: d.gl.getError(),
    };
  });
  expect(seed).toMatchObject({
    mode: "migan",
    seam: 0,
    center: [187, 187, 187, 255],
    rect: true,
    gl: 0,
  });
  await expect(page.locator("#dome-generate")).toBeHidden();
  const hasAiDepth = await page.evaluate(
    () => window.__dome.aiDepthMap !== null && window.__dome.aiDepthMap.depth.length > 0,
  );
  expect(hasAiDepth).toBe(true);
  await page.locator("#dome-outpainting").selectOption("mirrored");
  await expect(page.locator("#dome-generate")).toBeVisible();
  const mirroredAiDepth = await page.evaluate(() => window.__dome.aiDepthMap);
  expect(mirroredAiDepth).toBe(null);
  await page.locator("#dome-outpainting").selectOption("migan");
  await expect(page.locator("#dome-migan-status")).toContainText(
    "MI-GAN Ready",
    { timeout: 120000 },
  );
  expect(await page.evaluate(() => window.__dome.inpaintInfo.origin)).toBe(
    "Selected file",
  );
  const before = probes;
  await open(page, context);
  await upload(page);
  await page.locator("#dome-outpainting").selectOption("migan");
  await expect(page.locator("#dome-migan-status")).toContainText(
    "MI-GAN Ready",
    { timeout: 120000 },
  );
  expect(await page.evaluate(() => window.__dome.inpaintInfo.origin)).toBe(
    "Cached",
  );
  expect(probes).toBe(before);
  expect(errors).toEqual([]);
});
