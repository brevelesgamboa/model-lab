// Run matched, real-GPU organic texture comparisons and save a portable visual report.
// Usage: node tools/verify-dream-guidance.mjs [output-directory] [baseline-git-ref]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { createStaticServer } from "../server.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(
  process.argv[2] || "/tmp/latent-field-dream-guidance-quality",
);
const baselineRef = process.argv[3] || "99bcc35";
const bridgePath = "assets/js/models/neural-growth/dream-guidance.js";
const baselineSource = execFileSync(
  "git",
  ["show", `${baselineRef}:${bridgePath}`],
  { cwd: root, encoding: "utf8" },
);
await mkdir(output, { recursive: true });
const server = await createStaticServer(root);
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const browser = await chromium.launch({
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=gl", "--enable-gpu"],
});
const pageErrors = [];
const results = [];
let environment;
try {
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1100 },
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(
    `http://127.0.0.1:${server.address().port}/runtime-check.html`,
  );
  environment = await page.evaluate(async (source) => {
    const current =
      await import("/assets/js/models/neural-growth/dream-guidance.js");
    const { InceptionDreamModel } =
      await import("/assets/js/models/inception-dream.js");
    const { TextureNcaRuntime } =
      await import("/assets/js/models/neural-growth/runtime.js");
    const { validateCheckpoint, createRandom } =
      await import("/assets/js/models/neural-growth/reference.js");
    const owner = new InceptionDreamModel();
    const started = performance.now();
    const model = await owner.ensureModel();
    // Baseline keeps its old processing. Only add the missing endpoint and seed its jitter.
    source = source
      .replace(
        /from "(\.[^"]+)"/g,
        (_, relative) =>
          `from "${new URL(relative, new URL("/assets/js/models/neural-growth/dream-guidance.js", location.href)).href}"`,
      )
      .replace(
        "export const INCEPTION_LAYERS = Object.freeze({",
        `export const INCEPTION_LAYERS = Object.freeze({ Conv2d_4a_3x3: "${current.INCEPTION_LAYERS.Conv2d_4a_3x3}",`,
      )
      .replaceAll("Math.random() * 17", "this._random() * 17");
    const url = URL.createObjectURL(
      new Blob([source], { type: "text/javascript" }),
    );
    const legacy = await import(url);
    URL.revokeObjectURL(url);
    const rawModels = await Promise.all(
      ["membrane-field", "xeno-reef"].map(async (id) => [
        id,
        validateCheckpoint(
          await (
            await fetch(`/models/neural-growth/organic-structures/${id}.json`)
          ).json(),
        ),
      ]),
    );
    const checkpoints = Object.fromEntries(rawModels);
    const targetChecks = [];
    const warm = new TextureNcaRuntime({
      model: checkpoints["membrane-field"],
      size: 256,
      seed: 17,
    });
    warm.step(128);
    warm.step(128);
    const pixels = warm.readPhenotypeRgb();
    const debug = warm.gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = warm.gl.getParameter(
      debug?.UNMASKED_RENDERER_WEBGL || warm.gl.RENDERER,
    );
    const bridge = new current.DreamGuidanceBridge({
      getInceptionModel: () => ({ model }),
    });
    for (const [layer, channels] of Object.entries(
      current.INCEPTION_LAYER_CHANNELS,
    ).slice(0, 3)) {
      const gradient = await bridge.computeGradient(
        pixels,
        192,
        192,
        layer,
        channels - 1,
      );
      targetChecks.push({ layer, channels, bytes: gradient.length });
    }
    for (const Bridge of [
      current.DreamGuidanceBridge,
      legacy.DreamGuidanceBridge,
    ]) {
      const candidate = new Bridge({ getInceptionModel: () => ({ model }) });
      candidate._random = createRandom(17);
      for (const layer of ["Conv2d_4a_3x3", "mixed_5b"])
        await candidate.computeGradient(pixels, 192, 192, layer, 0);
      candidate.dispose();
    }
    bridge.dispose();
    warm.dispose();
    window.quality = {
      current,
      legacy,
      owner,
      model,
      checkpoints,
      TextureNcaRuntime,
      createRandom,
    };
    return {
      renderer,
      backend: globalThis.tf.getBackend(),
      initializationMs: performance.now() - started,
      targetChecks,
      tensors: globalThis.tf.memory().numTensors,
    };
  }, baselineSource);
  console.log(JSON.stringify({ environment }));

  const cases = [];
  for (const pattern of ["membrane-field", "xeno-reef"]) {
    cases.push({
      pattern,
      layer: "Conv2d_4a_3x3",
      channel: 0,
      strength: 0,
      version: "off",
    });
    for (const [layer, channel] of [
      ["Conv2d_4a_3x3", 0],
      ["mixed_5b", 120],
    ])
      for (const strength of [0.02, 0.03, 0.05])
        for (const version of ["before", "after"])
          cases.push({ pattern, layer, channel, strength, version });
  }
  for (const configuration of cases) {
    const result = await page.evaluate(async (config) => {
      const {
        current,
        legacy,
        model,
        checkpoints,
        TextureNcaRuntime,
        createRandom,
      } = window.quality;
      const Bridge = (config.version === "before" ? legacy : current)
        .DreamGuidanceBridge;
      const seed = 17;
      const runtime = new TextureNcaRuntime({
        model: checkpoints[config.pattern],
        size: 256,
        seed,
      });
      const bridge = new Bridge({
        getInceptionModel: () => ({ model }),
        random: createRandom(seed),
      });
      bridge._random = createRandom(seed);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const frames = [];
      const inferenceMs = [];
      const stepMs = [];
      let previous;
      let gradient;
      const baselineTensors = globalThis.tf.memory().numTensors;
      function capture(label) {
        runtime.draw(canvas, { displayFilter: "smooth", palette: "native" });
        const image = canvas.getContext("2d").getImageData(0, 0, 256, 256).data;
        let sum = 0,
          second = 0,
          high = 0,
          temporal = 0,
          clipped = 0,
          centerSum = 0,
          centerSecond = 0,
          centerN = 0;
        for (let y = 0; y < 256; y++)
          for (let x = 0; x < 256; x++) {
            for (let c = 0; c < 3; c++) {
              const i = (y * 256 + x) * 4 + c;
              const value = image[i] / 255;
              sum += value;
              second += value * value;
              clipped += value === 0 || value === 1 ? 1 : 0;
              temporal += previous ? ((image[i] - previous[i]) / 255) ** 2 : 0;
              const neighborMean =
                (image[(y * 256 + ((x + 1) % 256)) * 4 + c] +
                  image[(y * 256 + ((x + 255) % 256)) * 4 + c] +
                  image[(((y + 1) % 256) * 256 + x) * 4 + c] +
                  image[(((y + 255) % 256) * 256 + x) * 4 + c]) /
                1020;
              high += (value - neighborMean) ** 2;
              if (Math.hypot(x - 128, y - 128) < 25) {
                centerSum += value;
                centerSecond += value * value;
                centerN++;
              }
            }
          }
        const n = 256 * 256 * 3;
        frames.push({
          label,
          step: runtime.steps,
          png: canvas.toDataURL("image/png"),
          metrics: {
            mean: sum / n,
            std: Math.sqrt(Math.max(0, second / n - (sum / n) ** 2)),
            highFrequencyRms: Math.sqrt(high / n),
            frameDifferenceRms: Math.sqrt(temporal / n),
            clippedFraction: clipped / n,
            centerStd: Math.sqrt(
              Math.max(0, centerSecond / centerN - (centerSum / centerN) ** 2),
            ),
          },
        });
        previous = new Uint8Array(image);
      }
      async function advance(count) {
        for (let i = 0; i < count; i += 8) {
          if (config.strength) {
            const begin = performance.now();
            gradient = await bridge.computeGradient(
              runtime.readPhenotypeRgb(),
              192,
              192,
              config.layer,
              config.channel,
              true,
              0.005,
            );
            inferenceMs.push(performance.now() - begin);
            if (!gradient) throw new Error("Unexpected missing gradient");
            runtime.updateDreamGradient(gradient);
          }
          const begin = performance.now();
          runtime.step(8, { dreamStrength: config.strength, dreamChroma: 0 });
          runtime.gl.finish();
          stepMs.push((performance.now() - begin) / 8);
        }
      }
      try {
        runtime.step(128);
        runtime.step(128);
        capture("Start");
        for (let i = 32; i <= 192; i += 32) {
          await advance(32);
          capture(`Guidance +${i}`);
        }
        runtime.disturb(128, 128, 30, "erase");
        bridge.resetMomentum();
        runtime.clearDreamGradient();
        capture("Damage");
        for (let i = 32; i <= 192; i += 32) {
          await advance(32);
          capture(`Recovery +${i}`);
        }
        let gradientPng = null;
        if (gradient) {
          const map = document.createElement("canvas");
          map.width = map.height = 192;
          map
            .getContext("2d")
            .putImageData(
              new ImageData(new Uint8ClampedArray(gradient), 192, 192),
              0,
              0,
            );
          gradientPng = map.toDataURL("image/png");
        }
        const error = runtime.gl.getError();
        const stats = runtime.getStats();
        return {
          ...config,
          seed,
          gridSize: 256,
          resolution: 192,
          cadence: 8,
          frames,
          gradientPng,
          inferenceMs,
          stepMs,
          stats,
          glError: error,
          retainedTensors: globalThis.tf.memory().numTensors - baselineTensors,
        };
      } finally {
        bridge.dispose();
        runtime.dispose();
      }
    }, configuration);
    results.push(result);
    assert.equal(result.glError, 0, "WebGL error during matrix run");
    assert.equal(result.retainedTensors, 0, "Inference retained tensors");
    console.log(
      JSON.stringify({
        ...configuration,
        evaluations: result.inferenceMs.length,
        meanInferenceMs:
          result.inferenceMs.reduce((a, b) => a + b, 0) /
          (result.inferenceMs.length || 1),
        final: result.frames.at(-1).metrics,
      }),
    );
  }
  const gradientAudit = await page.evaluate(async () => {
    const {
      current,
      legacy,
      model,
      checkpoints,
      TextureNcaRuntime,
      createRandom,
    } = window.quality;
    const records = [];
    function metrics(values, previous) {
      let energy = 0,
        high = 0,
        change = 0;
      for (let y = 0; y < 192; y++)
        for (let x = 0; x < 192; x++)
          for (let c = 0; c < 3; c++) {
            const i = (y * 192 + x) * 3 + c;
            const v = values[i];
            const neighbors =
              (values[(y * 192 + ((x + 1) % 192)) * 3 + c] +
                values[(y * 192 + ((x + 191) % 192)) * 3 + c] +
                values[(((y + 1) % 192) * 192 + x) * 3 + c] +
                values[(((y + 191) % 192) * 192 + x) * 3 + c]) /
              4;
            energy += v * v;
            high += (v - neighbors) ** 2;
            if (previous) change += (v - previous[i]) ** 2;
          }
      return {
        rms: Math.sqrt(energy / values.length),
        highFrequencyRms: Math.sqrt(high / values.length),
        temporalRms: previous ? Math.sqrt(change / values.length) : null,
      };
    }
    for (const pattern of ["membrane-field", "xeno-reef"]) {
      const runtime = new TextureNcaRuntime({
        model: checkpoints[pattern],
        size: 256,
        seed: 17,
      });
      runtime.step(128);
      runtime.step(128);
      const pixels = runtime.readPhenotypeRgb();
      for (const [layer, channel] of [
        ["Conv2d_4a_3x3", 0],
        ["mixed_5b", 120],
      ]) {
        const featureMean = globalThis.tf.tidy(() => {
          const input = globalThis.tf.tensor4d(
            current.phenotypeBytesToFloatRgb(pixels, 192, 192),
            [1, 192, 192, 3],
          );
          return model
            .execute(input, current.INCEPTION_LAYERS[layer])
            .slice([0, 0, 0, channel], [-1, -1, -1, 1])
            .mean()
            .dataSync()[0];
        });
        for (const version of ["before", "after"]) {
          const Bridge = (version === "before" ? legacy : current)
            .DreamGuidanceBridge;
          const bridge = new Bridge({ getInceptionModel: () => ({ model }) });
          bridge._random = createRandom(17);
          const samples = [];
          let previous;
          for (let i = 0; i < 24; i++) {
            const bytes = await bridge.computeGradient(
              pixels,
              192,
              192,
              layer,
              channel,
              true,
              0.005,
            );
            const values = new Float32Array(192 * 192 * 3);
            for (let j = 0; j < values.length; j++)
              values[j] = (bytes[Math.floor(j / 3) * 4 + (j % 3)] - 127) / 127;
            samples.push(metrics(values, previous));
            previous = values;
          }
          const sigmas =
            version === "after"
              ? [1, 1.25, 1.5].map((sigma) => ({
                  sigma,
                  ...metrics(
                    current.applySpatialGradientSmoothing(
                      bridge._prevGrad,
                      192,
                      192,
                      sigma,
                    ),
                  ),
                }))
              : [];
          records.push({
            pattern,
            layer,
            channel,
            version,
            featureMean,
            samples,
            sigmas,
          });
          bridge.dispose();
        }
      }
      runtime.dispose();
    }
    return records;
  });
  await page.evaluate(async () => {
    await window.quality.owner.dispose();
  });
  assert.deepEqual(pageErrors, [], "Browser errors during matrix run");
  await mkdir(path.join(output, "frames"), { recursive: true });
  for (const [run, result] of results.entries()) {
    for (const [index, frame] of result.frames.entries()) {
      const filename = `frames/run-${run}-${index}.png`;
      await writeFile(
        path.join(output, filename),
        Buffer.from(frame.png.split(",")[1], "base64"),
      );
      frame.png = filename;
    }
    if (result.gradientPng) {
      const filename = `frames/gradient-${run}.png`;
      await writeFile(
        path.join(output, filename),
        Buffer.from(result.gradientPng.split(",")[1], "base64"),
      );
      result.gradientPng = filename;
    }
  }
  const report = {
    baselineRef,
    settings: {
      seed: 17,
      gridSize: 256,
      gradientResolution: 192,
      cadence: 8,
      jitter: true,
      tvWeight: 0.005,
      chroma: 0,
      sigma: 1.25,
      warmupSteps: 256,
      guidanceSteps: 192,
      recoverySteps: 192,
    },
    limitations: [
      "Synchronized inference before every eight NCA steps isolates visual quality; this is not a real-time app FPS measurement.",
      "Step timing is browser wall time, not a GPU timer query; use the live app to assess frame rate.",
      "Before uses the original pipeline with only endpoint lookup and seeded jitter adapted for the new stem target.",
      "Fixed seed, selected channels, and finite rollout cannot guarantee stability for every neuron or extended session.",
    ],
    environment,
    pageErrors,
    gradientAudit,
    results,
  };
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  const html = String.raw`<!doctype html><meta charset="utf-8"><title>Dream Guidance quality comparison</title>
  <style>body{background:#101218;color:#e4e8ed;font:15px system-ui;margin:24px}button,select,input{font:inherit}select,button{background:#252b38;color:inherit;padding:8px;border:1px solid #566077;border-radius:6px}img{max-width:100%;image-rendering:auto}#detail{display:grid;grid-template-columns:repeat(3,256px);gap:16px}figure{margin:0}figcaption{padding:6px 0;color:#b7c7d7}.row{display:grid;grid-template-columns:240px repeat(3,256px);gap:12px;margin:20px 0;align-items:center}p{max-width:1100px;line-height:1.5}#frame{width:500px}pre{white-space:pre-wrap;color:#b7c7d7}</style>
  <h1>Dream Guidance: matched organic texture runs</h1><p>Seed 17 · 256² field · 192² Inception gradient · jitter on · cadence 8 · TV 0.005 · achromatic injection. Channels: Conv2d_4a_3x3:0 and mixed_5b:120. Before: ${baselineRef} with stem endpoint added for comparison. After: aligned temporal history and Gaussian sigma 1.25.</p>
  <p id="environment"></p><p>Inference is synchronized for matched rollout steps. Timing here does not measure the live application's FPS. Fine texture and RGB saturation metrics alone do not prove motif quality or recovery.</p>
  <select id="case"></select> <button id="play">Play frames</button><p><input type="range" id="frame" min="0" max="13" value="6"><span id="label"></span></p><div id="detail"></div><pre id="metrics"></pre><h2>Frozen-field jitter audit</h2><p>Average gradient change between randomized input rolls, after eight warmup evaluations. Smaller values indicate more stable guidance on an unchanged field.</p><pre id="stability"></pre><h2>At guidance +192 steps</h2><p>Each row: guidance off · previous pipeline · fixed pipeline. All start from identical seeded fields.</p><div id="overview"></div>
  <script>const report=${JSON.stringify(report).replaceAll("<", "\\u003c")};
  const select=document.getElementById('case'), slider=document.getElementById('frame');
  const configs=report.results.filter(r=>r.version==='after');
  document.getElementById('environment').textContent=report.environment.renderer+' · TensorFlow '+report.environment.backend;
  document.getElementById('stability').textContent=report.gradientAudit.map(r=>r.pattern+' · '+r.layer+':'+r.channel+' · '+r.version+': '+(r.samples.slice(8).reduce((sum,s)=>sum+s.temporalRms,0)/16).toFixed(5)).join('\n');
  const figure=(r,index)=>'<figure><img src="'+r.frames[index].png+'"><figcaption>'+r.version+' · '+r.frames[index].label+'</figcaption></figure>';
  configs.forEach((r,i)=>{const o=document.createElement('option');o.value=i;o.textContent=r.pattern+' · '+r.layer+':'+r.channel+' · '+r.strength;select.append(o);const row=document.createElement('div');row.className='row';row.innerHTML='<div>'+o.textContent+'</div>'+matching(r).map(x=>figure(x,6)).join('');document.getElementById('overview').append(row);});
  function matching(r){return [report.results.find(x=>x.pattern===r.pattern&&x.version==='off'),report.results.find(x=>x.pattern===r.pattern&&x.layer===r.layer&&x.strength===r.strength&&x.version==='before'),r];}
  function render(){const runs=matching(configs[Number(select.value)]),index=Number(slider.value);document.getElementById('detail').innerHTML=runs.map(r=>figure(r,index)).join('');document.getElementById('label').textContent=runs[2].frames[index].label;document.getElementById('metrics').textContent=runs.map(r=>r.version+': '+JSON.stringify(r.frames[index].metrics)).join('\n');}
  select.onchange=slider.oninput=render;let timer;document.getElementById('play').onclick=()=>{if(timer){clearInterval(timer);timer=null;return;}timer=setInterval(()=>{slider.value=(Number(slider.value)+1)%14;render();},250);};render();</script>`;
  await writeFile(path.join(output, "comparison.html"), html);
  await page.goto(pathToFileURL(path.join(output, "comparison.html")).href);
  await page
    .locator("#overview img")
    .evaluateAll((images) =>
      Promise.all(images.map((image) => image.decode())),
    );
  await page
    .locator("#overview")
    .screenshot({ path: path.join(output, "overview.png") });
  console.log(`Saved report: ${output}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
