// Real-model panorama experiment; application routes and controls stay unchanged.
// node tools/experiment-dream-drift.mjs [--output directory] [--wasm] [--baseline-only] photo.jpg [...]
// Add --target-sweep for six targets at 4/8 gentle steps, or
// --forward-targets layer:channel,layer:channel for ten forward-regeneration stages.
// --forward-control-only repeats the same crop/projection without further inference.
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
let customOutput = false;
let forceWasm = false;
let baselineOnly = false;
let experimentMode = "standard";
let forwardTargets = [];
const candidateTargets = [
  {
    id: "webbing",
    label: "Webbing candidate",
    layer: "Conv2d_4a_3x3",
    channel: 42,
  },
  {
    id: "cellular",
    label: "Cellular control",
    layer: "mixed_5b",
    channel: 120,
  },
  { id: "arches", label: "Arches candidate", layer: "mixed_6a", channel: 42 },
  {
    id: "organic",
    label: "Organic forms candidate",
    layer: "mixed_6c",
    channel: 144,
  },
  {
    id: "lattices",
    label: "Lattice candidate",
    layer: "mixed_6d",
    channel: 182,
  },
  {
    id: "crystals",
    label: "Crystalline candidate",
    layer: "mixed_7b",
    channel: 314,
  },
];
const photos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--output") {
    assert.ok(args[i + 1], "--output requires a directory");
    output = path.resolve(args[++i]);
    customOutput = true;
  } else if (args[i] === "--wasm") forceWasm = true;
  else if (args[i] === "--baseline-only") baselineOnly = true;
  else if (args[i] === "--target-sweep") experimentMode = "target-sweep";
  else if (args[i] === "--forward-control-only")
    experimentMode = "forward-control";
  else if (args[i] === "--forward-targets") {
    experimentMode = "forward";
    assert.ok(
      args[i + 1],
      "--forward-targets requires two layer:channel targets",
    );
    forwardTargets = args[++i].split(",").map((text, index) => {
      const match = /^([A-Za-z0-9_]+):(\d+)$/.exec(text);
      assert.ok(match, "Use layer:channel for each forward target");
      return {
        id: `selected-${index + 1}`,
        label: text,
        layer: match[1],
        channel: Number(match[2]),
      };
    });
    assert.equal(
      forwardTargets.length,
      2,
      "Choose exactly two forward targets",
    );
  } else photos.push(path.resolve(args[i]));
}
assert.ok(
  photos.length,
  "Provide at least one photo; first photo gets progression tests.",
);
if (!customOutput && experimentMode !== "standard")
  output = path.join(root, `test-results/dream-drift-${experimentMode}`);
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
    experimentMode,
    requestedMiganBackend: forceWasm ? "wasm" : "automatic",
    baselineOnly,
    panorama: [1024, 512],
    target:
      experimentMode === "standard"
        ? { layer: "mixed_5b", channel: 120 }
        : undefined,
    candidateTargets:
      experimentMode === "target-sweep" ? candidateTargets : undefined,
    forwardTargets: experimentMode === "forward" ? forwardTargets : undefined,
    dreamStepSize: experimentMode === "standard" ? 0.04 : 0.012,
    sweepSteps: experimentMode === "target-sweep" ? [4, 8] : undefined,
    forwardPlan:
      experimentMode === "forward"
        ? {
            stages: 10,
            cropFraction: 0.92,
            dreamSteps: 4,
            targetOrder: [0, 0, 0, 1, 1, 1, 0, 0, 1, 1],
            cleanupOrReseeding: false,
          }
        : undefined,
    colorRetention: 1,
    independentSteps: experimentMode === "standard" ? [5, 15, 30] : undefined,
    recursiveSteps: experimentMode === "standard" ? [5, 5, 5] : undefined,
    outpaintingViewYawDegrees: experimentMode === "standard" ? 60 : undefined,
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
      "Legacy recursive outpainting reanchors a 60-degree view. The forward mode crops 8% from a front perspective view and reanchors it; neither reconstructs a 3D world.",
      "Gentle modes use the actual optimizer at step size 0.012 through an experiment-only worker; target names are hypotheses, not guaranteed motifs.",
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
  if (experimentMode !== "standard") {
    const workerSource = await readFile(
      new URL("./dream-drift-experiment.worker.mjs", import.meta.url),
      "utf8",
    );
    report.experimentWorkerSha256 = createHash("sha256")
      .update(workerSource)
      .digest("hex");
    await page.route(
      "**/assets/js/models/dream-drift-experiment.worker.js",
      (route) =>
        route.fulfill({ contentType: "text/javascript", body: workerSource }),
    );
  }
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
    async (entry, texture, views, front) => {
      await writeFile(
        path.join(output, entry.texture),
        Buffer.from(texture, "base64"),
      );
      if (views)
        await writeFile(
          path.join(output, entry.views),
          Buffer.from(views, "base64"),
        );
      if (front)
        await writeFile(
          path.join(output, entry.front),
          Buffer.from(front, "base64"),
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
    async ({
      inputs,
      forceWasm,
      baselineOnly,
      experimentMode,
      candidateTargets,
      forwardTargets,
    }) => {
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
      const { create360Canvas } =
        await import("/assets/js/models/equirectangular-canvas.js");
      const { luminanceDepth } =
        await import("/assets/js/models/depth-estimator.js");
      const model = new CorticalDreamDomeModel();
      const baker = new DomeDreamBaker(
        experimentMode === "standard"
          ? {}
          : {
              createWorker: () => {
                const worker = new Worker(
                  "/assets/js/models/dream-drift-experiment.worker.js",
                );
                const post = worker.postMessage.bind(worker);
                worker.postMessage = (data, transfers) =>
                  post({ ...data, stepSize: 0.012 }, transfers);
                return worker;
              },
            },
      );
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
        let front;
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
          if (i === 0) front = await encode(frame);
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
        return { sheet: await encode(sheet), front };
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
          experiment,
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
          front: captureViews ? `${input}-${id}-front.png` : null,
          elapsedMs,
          metrics: metrics(canvas, reference, rect),
          bake,
          experiment,
          provenance,
        };
        if (!entry.metrics.opaque)
          throw new Error(`${id} contains transparent pixels.`);
        const captures = captureViews ? await views(canvas, mapping) : null;
        await window.saveExperimentArtifact(
          entry,
          await encode(canvas),
          captures?.sheet,
          captures?.front,
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
      async function dream(
        seed,
        iterations,
        target = { layer: "mixed_5b", channel: 120 },
      ) {
        const result = await baker.bake(
          seed,
          target.layer,
          target.channel,
          iterations,
          {
            photoRect: null,
            colorRetention: 1,
          },
        );
        if (result.retainedTensors !== 0)
          throw new Error("Dream worker retained tensors.");
        if (experimentMode !== "standard" && result.stepSize !== 0.012)
          throw new Error("The gentle optimization step was not applied.");
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
          if (experimentMode === "target-sweep") {
            for (const target of candidateTargets) {
              for (const steps of [4, 8]) {
                const result = await dream(generated.canvas, steps, target);
                await save(
                  input.id,
                  `sweep-${target.id}-${steps}`,
                  `${target.label} · ${steps} gentle steps`,
                  result.canvas,
                  {
                    reference: generated.canvas,
                    bake: result.bake,
                    elapsedMs: result.bake.bakeMs,
                    experiment: {
                      phase: "sweep",
                      target,
                      steps,
                      stepSize: 0.012,
                    },
                    provenance:
                      "Same MI-GAN seed; palette preserved; no protected photo region or optical effects",
                  },
                );
              }
            }
            continue;
          }
          if (experimentMode === "forward") {
            let previous = generated.canvas;
            let parent = "migan";
            const targetOrder = [0, 0, 0, 1, 1, 1, 0, 0, 1, 1];
            for (let stage = 1; stage <= 10; stage++) {
              const target = forwardTargets[targetOrder[stage - 1]];
              await present(previous, "migan");
              await model.render(frame, parameters, 0);
              const context = new OffscreenCanvas(frame.width, frame.height);
              const cropFraction = 0.92;
              context
                .getContext("2d")
                .drawImage(
                  frame,
                  (frame.width * (1 - cropFraction)) / 2,
                  (frame.height * (1 - cropFraction)) / 2,
                  frame.width * cropFraction,
                  frame.height * cropFraction,
                  0,
                  0,
                  frame.width,
                  frame.height,
                );
              const experiment = {
                phase: "forward",
                stage,
                parent,
                target,
                cropFraction,
                yaw: 0,
                dreamSteps: 4,
                stepSize: 0.012,
              };
              await save(
                input.id,
                `forward-${stage}-context`,
                `Stage ${stage} · forward context`,
                context,
                { captureViews: false, mapping: "perspective", experiment },
              );
              const next = await outpaint(context);
              await save(
                input.id,
                `forward-${stage}-raw`,
                `Stage ${stage} · raw outpaint`,
                next.raw,
                { captureViews: false, elapsedMs: next.elapsedMs, experiment },
              );
              await save(
                input.id,
                `forward-${stage}-outpaint`,
                `Stage ${stage} · outpaint before Dream`,
                next.canvas,
                {
                  reference: previous,
                  elapsedMs: next.elapsedMs,
                  experiment,
                  provenance:
                    "Front view cropped by 8%, then reanchored and outpainted. No rescue or reset of accumulated errors.",
                },
              );
              const result = await dream(next.canvas, 4, target);
              await save(
                input.id,
                `forward-${stage}`,
                `Stage ${stage} · ${target.layer}:${target.channel}`,
                result.canvas,
                {
                  reference: next.canvas,
                  bake: result.bake,
                  elapsedMs: result.bake.bakeMs,
                  experiment,
                  provenance:
                    "Actual model synthesis after context regeneration; no authored glitch or motion filter",
                },
              );
              previous = result.canvas;
              parent = `forward-${stage}`;
            }
            continue;
          }
          if (experimentMode === "forward-control") {
            let previous = generated.canvas;
            for (let stage = 1; stage <= 10; stage++) {
              await present(previous, "migan");
              await model.render(frame, parameters, 0);
              const context = new OffscreenCanvas(frame.width, frame.height);
              const cropFraction = 0.92;
              context
                .getContext("2d")
                .drawImage(
                  frame,
                  (frame.width * (1 - cropFraction)) / 2,
                  (frame.height * (1 - cropFraction)) / 2,
                  frame.width * cropFraction,
                  frame.height * cropFraction,
                  0,
                  0,
                  frame.width,
                  frame.height,
                );
              const canvas = create360Canvas(context, 1024, 512, {
                coverage: "immersive",
              });
              const rect = canvas.photoRect;
              canvas
                .getContext("2d")
                .drawImage(context, rect.x, rect.y, rect.width, rect.height);
              await save(
                input.id,
                `forward-control-${stage}`,
                `Control stage ${stage} · no further inference`,
                canvas,
                {
                  reference: previous,
                  experiment: {
                    phase: "forward-control",
                    stage,
                    cropFraction,
                    yaw: 0,
                    dreamSteps: 0,
                  },
                  provenance:
                    "Same front-view crop and photo placement, followed by the existing border initializer. No MI-GAN or Dream after the initial seed; peripheral fill differs from the synthesis chain.",
                },
              );
              previous = canvas;
            }
            continue;
          }
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
    {
      inputs,
      forceWasm,
      baselineOnly,
      experimentMode,
      candidateTargets,
      forwardTargets,
    },
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
