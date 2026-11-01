// Real-model panorama experiment; application routes and controls stay unchanged.
// node tools/experiment-dream-drift.mjs [--output directory] [--wasm] [--baseline-only] photo.jpg [...]
// Outputs include raw MI-GAN pixels, sphere-ready textures, six dome views,
// independent Dream strengths, recursive Dream/outpainting, and a local gallery.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createStaticServer } from "../server.mjs";
import { writeDreamDriftGallery } from "./dream-drift-gallery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let output = path.join(root, "test-results/dream-drift-marmots");
let forceWasm = false;
let baselineOnly = false;
const photos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--output") {
    assert.ok(args[i + 1], "--output requires a directory");
    output = path.resolve(args[++i]);
  } else if (args[i] === "--wasm") forceWasm = true;
  else if (args[i] === "--baseline-only") baselineOnly = true;
  else photos.push(path.resolve(args[i]));
}
assert.ok(
  photos.length,
  "Provide at least one photo; first photo gets progression tests.",
);
const inputs = await Promise.all(
  photos.map(async (file, i) => {
    const bytes = await readFile(file);
    return {
      id: `photo-${i + 1}`,
      name: path.basename(file),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      base64: bytes.toString("base64"),
    };
  }),
);
await mkdir(output, { recursive: true });
const report = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  branch: execFileSync("git", ["branch", "--show-current"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  startedAt: new Date().toISOString(),
  runnerSha256: createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest("hex"),
  status: "running",
  inputs: inputs.map(({ id, name, sha256 }) => ({ id, name, sha256 })),
  configuration: {
    requestedMiganBackend: forceWasm ? "wasm" : "automatic",
    baselineOnly,
    panorama: [1024, 512],
    target: { layer: "mixed_5b", channel: 120 },
    colorRetention: 1,
    independentSteps: [5, 15, 30],
    recursiveSteps: [5, 5, 5],
    outpaintingViewYawDegrees: 60,
    effects: {
      waves: 0,
      refraction: 0,
      dispersion: 0,
      depthRelief: 0,
      neuralRelief: 0,
      cameraDolly: 0,
    },
    notes: [
      "Uses the installed MI-GAN pipeline v2 and local InceptionV3 workers without stubs.",
      "Mirrored textures require the dome's mirrored mapping; their flat texture is not a full panorama.",
      "Raw MI-GAN output is saved before the existing photo/seam/pole compositor.",
      "Dream-on-MI-GAN is an experiment harness combination, not a newly enabled application mode.",
      "Progression releases photo protection; all independent strengths start from the same MI-GAN panorama.",
      "Recursive outpainting reanchors a 60-degree perspective view; it does not demonstrate forward travel.",
      "Six-view captures use the actual dome renderer with all relief and optical effects disabled.",
      "Timing includes real inference but does not establish simultaneous-generation frame rate.",
    ],
  },
  artifacts: [],
  errors: [],
};
const persist = () =>
  writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
await persist();
const server = await createStaticServer(root);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=vulkan",
      "--enable-features=Vulkan",
      "--enable-gpu",
      "--enable-unsafe-webgpu",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(180000);
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.route(`${origin}/`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Dream Drift model experiment</title><body></body>",
    }),
  );
  await page.route(/^https?:\/\//, (route) => {
    if (new URL(route.request().url()).origin === origin)
      return route.fallback();
    report.errors.push(`Unexpected external request: ${route.request().url()}`);
    return route.abort();
  });
  await page.exposeFunction(
    "saveExperimentArtifact",
    async (entry, texture, views) => {
      await writeFile(
        path.join(output, entry.texture),
        Buffer.from(texture, "base64"),
      );
      if (views)
        await writeFile(
          path.join(output, entry.views),
          Buffer.from(views, "base64"),
        );
      report.artifacts.push(entry);
      await persist();
      console.log(
        `${entry.input}: ${entry.label} (${Math.round(entry.elapsedMs || 0)} ms)`,
      );
    },
  );
  await page.goto(origin);
  report.hardware = await page.evaluate(async () => {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) throw new Error("WebGL2 is required for real-model testing.");
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const adapter = await navigator.gpu?.requestAdapter();
    return {
      renderer: gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL || gl.RENDERER),
      webgpu: adapter
        ? {
            vendor: adapter.info.vendor,
            isFallbackAdapter: adapter.info.isFallbackAdapter,
          }
        : null,
    };
  });
  console.log(JSON.stringify(report.hardware));
  const inference = await page.evaluate(
    async ({ inputs, forceWasm, baselineOnly }) => {
      const { CorticalDreamDomeModel } =
        await import("/assets/js/models/cortical-dream-dome.js");
      const { getMiganSession, MiganLoader } =
        await import("/assets/js/models/migan-loader.js");
      const { inpaintEquirectangular } =
        await import("/assets/js/models/migan-inpainter.js");
      const { DomeDreamBaker } =
        await import("/assets/js/models/inception-dream-bake.js");
      const { photoProtection } =
        await import("/assets/js/models/equirectangular-canvas.js");
      const { luminanceDepth } =
        await import("/assets/js/models/depth-estimator.js");
      const model = new CorticalDreamDomeModel();
      const baker = new DomeDreamBaker();
      const session = forceWasm
        ? await new MiganLoader({ mode: () => "wasm" }).get()
        : await getMiganSession();
      if (!session)
        throw new Error(
          "Install models/inpainting/migan_pipeline_v2.onnx first.",
        );
      await model.ensureGraphics();
      const parameters = Object.fromEntries(
        model.controls.map((control) => [control.key, control.default]),
      );
      Object.assign(parameters, {
        gain: 0,
        edgeCoupling: 0,
        chromaticDispersion: 0,
        depthScale: 0,
        neuralSwell: 0,
        cameraDolly: 0,
      });
      const frame = document.createElement("canvas");
      frame.width = 512;
      frame.height = 384;
      const encode = async (canvas) => {
        const blob = canvas.convertToBlob
          ? await canvas.convertToBlob({ type: "image/png" })
          : await new Promise((resolve) => canvas.toBlob(resolve));
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(",")[1]);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      };
      function pixels(canvas) {
        return canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height).data;
      }
      function metrics(canvas, reference, rect) {
        const data = pixels(canvas),
          w = canvas.width,
          h = canvas.height;
        const before = reference ? pixels(reference) : null;
        let seam = 0,
          seamMax = 0,
          neighboring = 0,
          change = 0,
          count = 0;
        let protectedMax = 0,
          edgeEnergy = 0,
          opaque = true;
        for (let y = 0; y < h; y++) {
          for (let c = 0; c < 3; c++) {
            const delta = Math.abs(
              data[y * w * 4 + c] - data[(y * w + w - 1) * 4 + c],
            );
            seam += delta;
            seamMax = Math.max(seamMax, delta);
            neighboring += Math.abs(
              data[y * w * 4 + c] - data[(y * w + 1) * 4 + c],
            );
          }
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const protectedPixel = rect && photoProtection(x, y, rect) === 1;
            opaque &&= data[i + 3] === 255;
            if (protectedPixel && before) {
              for (let c = 0; c < 3; c++)
                protectedMax = Math.max(
                  protectedMax,
                  Math.abs(data[i + c] - before[i + c]),
                );
            }
            if (protectedPixel) continue;
            count++;
            for (let c = 0; c < 3; c++) {
              if (before) change += Math.abs(data[i + c] - before[i + c]);
              if (x > 0) edgeEnergy += Math.abs(data[i + c] - data[i - 4 + c]);
            }
          }
        }
        return {
          width: w,
          height: h,
          opaque,
          seamMeanByte: seam / (h * 3),
          seamMaxByte: seamMax,
          seamNeighborMeanByte: neighboring / (h * 3),
          meanChangeByte: before ? change / Math.max(1, count * 3) : null,
          protectedMaxByte: before && rect ? protectedMax : null,
          meanHorizontalEdgeByte: edgeEnergy / Math.max(1, count * 3),
        };
      }
      async function present(canvas, mapping) {
        model.panorama = canvas;
        model.outpaintingMode = mapping;
        model.photoRect = canvas.photoRect || {
          x: 0,
          y: 0,
          width: canvas.width,
          height: canvas.height,
          feather: 1,
        };
        model.aiDepthMap = mapping === "migan" ? luminanceDepth(canvas) : null;
        model.camera.reset();
        model.uploadSource();
      }
      async function views(canvas, mapping) {
        await present(canvas, mapping);
        const sheet = new OffscreenCanvas(1536, 816),
          ctx = sheet.getContext("2d");
        const angles = [
          ["Front", 0, 0],
          ["Right", Math.PI / 2, 0],
          ["Rear", Math.PI, 0],
          ["Left", -Math.PI / 2, 0],
          ["Ceiling", 0, 1.45],
          ["Floor", 0, -1.45],
        ];
        for (let i = 0; i < angles.length; i++) {
          const [label, yaw, pitch] = angles[i];
          model.camera.yaw = yaw;
          model.camera.pitch = pitch;
          await model.render(frame, parameters, 0);
          const x = (i % 3) * 512,
            y = Math.floor(i / 3) * 408;
          ctx.fillStyle = "#111";
          ctx.fillRect(x, y, 512, 408);
          ctx.fillStyle = "#eee";
          ctx.font = "16px sans-serif";
          ctx.fillText(label, x + 10, y + 18);
          ctx.drawImage(frame, x, y + 24);
        }
        if (model.gl.getError() !== 0)
          throw new Error("Dome renderer produced a WebGL error.");
        return encode(sheet);
      }
      async function save(
        input,
        id,
        label,
        canvas,
        {
          mapping = "migan",
          reference,
          rect,
          elapsedMs = 0,
          bake,
          provenance,
          captureViews = true,
        } = {},
      ) {
        const entry = {
          input,
          id,
          label,
          mapping,
          texture: `${input}-${id}.png`,
          views: captureViews ? `${input}-${id}-views.png` : null,
          elapsedMs,
          metrics: metrics(canvas, reference, rect),
          bake,
          provenance,
        };
        if (!entry.metrics.opaque)
          throw new Error(`${id} contains transparent pixels.`);
        await window.saveExperimentArtifact(
          entry,
          await encode(canvas),
          captureViews ? await views(canvas, mapping) : null,
        );
      }
      async function outpaint(source) {
        let raw;
        const start = performance.now();
        const canvas = await inpaintEquirectangular(source, {
          run: async (feeds) => {
            const outputs = await session.run(feeds);
            const tensor = outputs.result,
              data = await tensor.getData();
            const [, , height, width] = tensor.dims,
              count = width * height;
            const rgba = new Uint8ClampedArray(count * 4);
            for (let i = 0; i < count; i++)
              rgba.set(
                [data[i], data[count + i], data[2 * count + i], 255],
                i * 4,
              );
            raw = new OffscreenCanvas(width, height);
            raw
              .getContext("2d")
              .putImageData(new ImageData(rgba, width, height), 0, 0);
            return outputs;
          },
        });
        return { canvas, raw, elapsedMs: performance.now() - start };
      }
      async function dream(seed, iterations) {
        const result = await baker.bake(seed, "mixed_5b", 120, iterations, {
          photoRect: null,
          colorRetention: 1,
        });
        if (result.retainedTensors !== 0)
          throw new Error("Dream worker retained tensors.");
        const canvas = new OffscreenCanvas(result.width, result.height);
        canvas
          .getContext("2d")
          .putImageData(
            new ImageData(result.rgba, result.width, result.height),
            0,
            0,
          );
        const bake = { ...result };
        delete bake.rgba;
        return { canvas, bake };
      }
      try {
        for (const [index, input] of inputs.entries()) {
          const bytes = Uint8Array.from(atob(input.base64), (c) =>
            c.charCodeAt(0),
          );
          const bitmap = await createImageBitmap(new Blob([bytes]));
          const scale = Math.min(
            1,
            2048 / Math.max(bitmap.width, bitmap.height),
          );
          model.source.width = Math.round(bitmap.width * scale);
          model.source.height = Math.round(bitmap.height * scale);
          model.source
            .getContext("2d")
            .drawImage(bitmap, 0, 0, model.source.width, model.source.height);
          bitmap.close();
          model.depthMap = luminanceDepth(model.source);
          model.prepareSurround();
          const mirror = model.mirrorSeed;
          await save(input.id, "source", "Original source", model.source, {
            captureViews: false,
            mapping: "source",
          });
          await save(input.id, "mirrored", "Mirrored baseline", mirror, {
            mapping: "mirrored",
          });
          const generated = await outpaint(model.source);
          const alignedSource = new OffscreenCanvas(1024, 512);
          const rect = generated.canvas.photoRect;
          alignedSource
            .getContext("2d")
            .drawImage(model.source, rect.x, rect.y, rect.width, rect.height);
          await save(
            input.id,
            "migan-raw",
            "Raw MI-GAN output",
            generated.raw,
            {
              captureViews: false,
              elapsedMs: generated.elapsedMs,
            },
          );
          await save(input.id, "migan", "MI-GAN panorama", generated.canvas, {
            reference: alignedSource,
            rect,
            elapsedMs: generated.elapsedMs,
            provenance:
              "Photo-preserving composition plus existing seam/pole treatment",
          });
          if (
            metrics(generated.canvas, alignedSource, rect).protectedMaxByte !==
            0
          )
            throw new Error("MI-GAN changed the protected photo core.");
          const baseline = await dream(mirror, 15);
          await save(
            input.id,
            "dream-mirrored-15",
            "Current mirrored Dream · 15 steps",
            baseline.canvas,
            {
              mapping: "mirrored",
              reference: mirror,
              bake: baseline.bake,
              elapsedMs: baseline.bake.bakeMs,
            },
          );
          if (index > 0 || baselineOnly) continue;
          for (const steps of [5, 15, 30]) {
            const result = await dream(generated.canvas, steps);
            await save(
              input.id,
              `independent-${steps}`,
              `Same MI-GAN seed · ${steps} Dream steps`,
              result.canvas,
              {
                reference: generated.canvas,
                bake: result.bake,
                elapsedMs: result.bake.bakeMs,
                provenance:
                  "Independent run; original photo protection released",
              },
            );
          }
          let recursive = generated.canvas;
          for (let pass = 1; pass <= 3; pass++) {
            const result = await dream(recursive, 5);
            await save(
              input.id,
              `recursive-dream-${pass}`,
              `Recursive Dream · pass ${pass} of 3`,
              result.canvas,
              {
                reference: generated.canvas,
                bake: result.bake,
                elapsedMs: result.bake.bakeMs,
                provenance:
                  "Five new steps from the previous output; octave/jitter restart differs from one continuous run",
              },
            );
            recursive = result.canvas;
          }
          recursive = generated.canvas;
          for (let pass = 1; pass <= 2; pass++) {
            await present(recursive, "migan");
            model.camera.yaw = Math.PI / 3;
            await model.render(frame, parameters, 0);
            const context = new OffscreenCanvas(frame.width, frame.height);
            context.getContext("2d").drawImage(frame, 0, 0);
            await save(
              input.id,
              `outpaint-context-${pass}`,
              `Generated view supplied to outpaint ${pass}`,
              context,
              { captureViews: false, mapping: "perspective" },
            );
            const result = await outpaint(context);
            await save(
              input.id,
              `recursive-outpaint-${pass}-raw`,
              `Raw recursive outpaint · pass ${pass}`,
              result.raw,
              { captureViews: false, elapsedMs: result.elapsedMs },
            );
            await save(
              input.id,
              `recursive-outpaint-${pass}`,
              `View-conditioned outpaint · pass ${pass}`,
              result.canvas,
              {
                elapsedMs: result.elapsedMs,
                provenance:
                  "60-degree view from the prior generated panorama, reanchored as next context; no forward-motion claim",
              },
            );
            recursive = result.canvas;
          }
        }
        return {
          migan: session.miganInfo,
          dreamRuns: baker.runs,
          glError: model.gl.getError(),
        };
      } finally {
        baker.dispose();
        model.dispose();
        await session.release();
      }
    },
    { inputs, forceWasm, baselineOnly },
  );
  report.inference = inference;
  assert.equal(inference.glError, 0);
  assert.deepEqual(report.errors, []);
  report.status = "complete";
} catch (error) {
  report.status = "failed";
  report.errors.push(error.stack || String(error));
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await persist();
  await writeDreamDriftGallery(output, report);
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
console.log(`Review: ${path.join(output, "index.html")}`);
