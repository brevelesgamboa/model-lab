// Node 24, prepared local models, Playwright Chromium, real WebGL GPU, and ffmpeg.
// node tools/verify-inception-motion.mjs [output] [--quick]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { createStaticServer } from "../server.mjs";

const quick = process.argv.includes("--quick");
const output = path.resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ||
    "/tmp/latent-field-inception-motion",
);
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(output, "frames"), { recursive: true });
await mkdir(path.join(output, "clips"), { recursive: true });
const server = await createStaticServer(root);
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const url = `http://127.0.0.1:${server.address().port}/runtime-check.html`;
const browser = await chromium.launch({
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=gl", "--enable-gpu"],
});
const errors = [],
  results = [],
  profiles = [],
  clips = [],
  frozen = [],
  matchedVortices = [];
let report;
try {
  const page = await browser.newPage({
    viewport: { width: 1300, height: 1000 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  async function initialize(target) {
    await target.goto(url);
    return target.evaluate(async () => {
      window.bench =
        await import("/assets/js/diagnostics/motion-experiment.js");
      window.benchEnvironment = await window.bench.initializeExperiment();
      return {
        environment: window.benchEnvironment.environment,
        targets: window.bench.MOTION_TARGETS,
      };
    });
  }
  const { environment, targets } = await initialize(page);
  report = {
    environment,
    settings: {
      seeds: quick ? [17] : [1, 17, 42],
      grid: 256,
      coarseGrid: 16,
      maxSpeed: 0.05,
      cadence: 16,
      horizon: 16,
      learningRate: 0.003,
      momentum: 0.9,
      initialField: "zero",
      gaussianSigma: 1,
      maxCoarseNeighborDelta: 0.02,
      maxTemporalDelta: 0.005,
      targets,
    },
    frozen,
    results,
    matchedVortices,
    profiles,
    clips,
    errors,
  };
  const save = () =>
    writeFile(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
  console.log(JSON.stringify({ environment, targets }));
  for (const pattern of ["membrane-field", "xeno-reef"]) {
    const records = await page.evaluate(
      (pattern) =>
        window.bench.frozenFieldAudit(window.benchEnvironment, pattern),
      pattern,
    );
    for (const { derivative } of records) {
      const { analytic, numeric } = derivative.nonzeroField;
      assert.ok(
        Math.abs(analytic - numeric) <
          Math.max(0.005, Math.abs(analytic) * 0.05),
        "Real Inception displacement derivative disagrees with finite differences.",
      );
    }
    frozen.push(...records);
    await save();
    console.log(
      JSON.stringify({
        phase: "frozen",
        pattern,
        targets: records.map(
          ({ layer, channel, before, actualQuantizedWarpScore, history }) => ({
            layer,
            channel,
            before,
            actualQuantizedWarpScore,
            final: history.at(-1),
          }),
        ),
      }),
    );
  }
  async function storeResult(result, name) {
    for (const [i, frame] of result.frames.entries())
      if (frame.image) {
        const filename = `frames/${name}-${i}.png`;
        await writeFile(
          path.join(output, filename),
          Buffer.from(frame.image.split(",")[1], "base64"),
        );
        frame.image = filename;
      }
    assert.equal(result.glError, 0);
    assert.equal(result.retainedTensors, 0);
    assert.ok(result.updates.every((update) => update.maxSpeed <= 0.05));
    return result;
  }
  for (const pattern of ["membrane-field", "xeno-reef"])
    for (const seed of report.settings.seeds) {
      const configurations = [
        { condition: "A" },
        { condition: "B" },
        ...targets.map((target) => ({ condition: "C", ...target })),
      ];
      for (const config of configurations) {
        const result = await page.evaluate(
          ({ config, options }) =>
            window.bench.runCase(window.benchEnvironment, config, options),
          {
            config: { pattern, seed, size: 256, ...config },
            options: { steps: quick ? 256 : 1024, recovery: quick ? 64 : 256 },
          },
        );
        results.push(await storeResult(result, `case-${results.length}`));
        await save();
        console.log(
          JSON.stringify({
            phase: "matrix",
            pattern,
            seed,
            ...config,
            rgbStd: result.frames.find(
              (frame) => frame.label === `Flow +${result.steps}`,
            )?.state.rgbStd,
            finalField: result.updates.at(-1) || null,
          }),
        );
      }
    }
  // Follow-up controls match the learned field's mean coarse-grid RMS speed.
  for (const learned of results.filter(
    (result) => result.condition === "C" && result.seed === 17,
  )) {
    const samples = learned.updates
      .filter((update) => update.activeStep <= learned.steps)
      .slice(-16);
    const rms =
      samples.reduce((sum, update) => sum + update.rmsSpeed, 0) /
      samples.length;
    const vortexSpeed = Math.min(0.05, Math.SQRT2 * rms);
    const result = await page.evaluate(
      ({ config, options }) =>
        window.bench.runCase(window.benchEnvironment, config, options),
      {
        config: {
          pattern: learned.pattern,
          seed: 17,
          size: 256,
          condition: "B",
          layer: learned.layer,
          channel: learned.channel,
          vortexSpeed,
        },
        options: { steps: learned.steps, recovery: learned.recovery },
      },
    );
    matchedVortices.push(
      await storeResult(result, `matched-${matchedVortices.length}`),
    );
    await save();
  }
  if (!quick) {
    for (const pattern of ["membrane-field", "xeno-reef"])
      for (const config of [
        { condition: "A" },
        { condition: "B" },
        ...targets.map((target) => ({ condition: "C", ...target })),
      ]) {
        const profile = await page.evaluate(
          (config) => window.bench.profileCase(window.benchEnvironment, config),
          { pattern, seed: 17, size: 256, ...config },
        );
        const sorted = [...profile.frameIntervals].sort((a, b) => a - b);
        const latency = profile.inferences
          .map((update) => update.elapsedMs)
          .sort((a, b) => a - b);
        const percentile = (values, p) =>
          values[Math.min(values.length - 1, Math.floor(values.length * p))] ??
          null;
        Object.assign(profile, {
          frameP50Ms: percentile(sorted, 0.5),
          frameP95Ms: percentile(sorted, 0.95),
          frameP99Ms: percentile(sorted, 0.99),
          frameMaxMs: sorted.at(-1),
          inferenceP50Ms: percentile(latency, 0.5),
          inferenceP95Ms: percentile(latency, 0.95),
        });
        assert.equal(profile.glError, 0);
        profiles.push(profile);
        await save();
        console.log(
          JSON.stringify({
            phase: "profile",
            pattern,
            ...config,
            fps: profile.fps,
            updatesPerSecond: profile.updatesPerSecond,
            frameP95Ms: profile.frameP95Ms,
            frameP99Ms: profile.frameP99Ms,
            inferenceP50Ms: profile.inferenceP50Ms,
          }),
        );
      }
    await page.evaluate(() => window.benchEnvironment.owner.dispose());
    for (const pattern of ["membrane-field", "xeno-reef"])
      for (const target of targets) {
        const context = await browser.newContext({
          viewport: { width: 1024, height: 650 },
          recordVideo: {
            dir: path.join(output, "raw-clips"),
            size: { width: 1024, height: 650 },
          },
        });
        const clipPage = await context.newPage();
        clipPage.on("pageerror", (error) => errors.push(error.message));
        const video = clipPage.video();
        await initialize(clipPage);
        const result = await clipPage.evaluate(
          (config) =>
            window.bench.recordComparison(window.benchEnvironment, config),
          { pattern, ...target },
        );
        const poster = `clips/${pattern}-${target.layer}-${target.channel}.png`;
        await clipPage.screenshot({ path: path.join(output, poster) });
        await clipPage.evaluate(() => window.benchEnvironment.owner.dispose());
        await context.close();
        const source = await video.path();
        const filename = `clips/${pattern}-${target.layer}-${target.channel}.webm`;
        // Remove model loading and warmup frames; keep the actual shared playback.
        execFileSync("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-sseof",
          `-${result.elapsedMs / 1000}`,
          "-i",
          source,
          "-c:v",
          "libvpx-vp9",
          "-crf",
          "28",
          "-b:v",
          "0",
          "-deadline",
          "realtime",
          "-cpu-used",
          "6",
          "-an",
          path.join(output, filename),
        ]);
        assert.ok(result.glErrors.every((error) => error === 0));
        clips.push({ ...result, filename, poster });
        await save();
        console.log(
          JSON.stringify({ phase: "clip", pattern, ...target, filename }),
        );
      }
    await rm(path.join(output, "raw-clips"), { recursive: true, force: true });
  } else await page.evaluate(() => window.benchEnvironment.owner.dispose());
  assert.deepEqual(errors, []);
  report.notes = [
    "Frozen Inception and NCA weights; only 512 displacement values are optimized.",
    "Velocity is cells per NCA update; native 256px scoring avoids resampling-scale mismatch.",
    "The floating-point surrogate predicts a 16-update warp of the current image; it does not differentiate through NCA rollout or RGBA8 rounding.",
    "Fields use periodic Gaussian smoothing, a central-difference divergence projection, bounded coarse-neighbor differences, bounded temporal change, and magnitude limits at CPU upload and GPU sampling.",
    "Coarse-node RMS is reported for amplitude matching; full-resolution interpolation can slightly lower actual RMS.",
    "Offline matrix updates are synchronized for matched simulation steps. Performance is measured separately with one asynchronous inference in flight.",
    "Live frame timings use a warmed, headless Chromium harness at 256×256 cells and 30 NCA updates/second; model loading and first shader compilation are excluded.",
    "Combined comparison clips share playback and are not the source of individual-condition frame timings.",
    "A rising activation score does not by itself establish visual value or motif emergence.",
  ];
  await save();
  const html = String.raw`<!doctype html><meta charset="utf-8"><title>Inception displacement experiment</title><style>body{font:16px system-ui;background:#101218;color:#e4e8ed;margin:24px}p,li{max-width:1150px;line-height:1.5}a{color:#82caff}img{max-width:100%;width:256px}figure{margin:0}figcaption{color:#b7c7d7;margin:6px 0}.row{display:flex;gap:16px;margin:20px 0;align-items:center}.label{width:230px;flex-shrink:0}video{width:100%;max-width:1024px}table{border-collapse:collapse}td,th{border:1px solid #536077;padding:8px;text-align:left}select{font:inherit;padding:8px;background:#252b38;color:inherit}#step{width:500px}canvas{background:#18202b}</style>
  <h1>Inception-guided displacement</h1><p id="hardware"></p><p>A: ordinary NCA. B: deterministic vortex at 0.05 cells/update. C: a zero-initialized 16×16 velocity grid optimized for an InceptionV3 channel. All 12 simulation channels move together.</p><p>Three seeds and four isolated targets; one gradient update per 16 NCA updates. Fields are smoothed, constrained against compression and shear, and capped at 0.05 cells/update. Target-score gains and visual quality are separate outcomes.</p><select id="case"></select><p><input id="step" type="range" value="3" min="0"><span id="label"></span></p><p><label><input id="match-speed" type="checkbox"> Also show a vortex matched to C’s mean RMS speed</label></p><div id="comparison" class="row"></div><p id="velocity"></p><canvas id="field" width="256" height="256"></canvas><h2>Matched seed 17: before damage</h2><div id="overview"></div><h2>Independent live frame timings</h2><table id="performance"><tr><th>Model / condition</th><th>Target</th><th>FPS</th><th>Updates/sec</th><th>p95 / p99 frame ms</th><th>Median / p95 inference ms</th></tr></table><h2>Comparison clips</h2><div id="clips"></div><h2>Method and limits</h2><ul id="notes"></ul><p><a href="report.json">Full settings, fields, scores, structural metrics and timings</a></p><script>
  const report=${JSON.stringify(report).replaceAll("<", "\\u003c")};
  document.getElementById('hardware').textContent=report.environment.renderer+' · TensorFlow '+report.environment.backend;
  const cases=report.results.filter(r=>r.seed===17&&r.condition==='C'),select=document.getElementById('case'),slider=document.getElementById('step');
  const figure=(f,label)=>'<figure><img src="'+f.image+'"><figcaption>'+label+'</figcaption></figure>';
  function group(r, matched=false){const group=['A','B'].map(condition=>report.results.find(x=>x.pattern===r.pattern&&x.seed===r.seed&&x.condition===condition)).concat(r);if(matched){const control=report.matchedVortices.find(x=>x.pattern===r.pattern&&x.layer===r.layer&&x.channel===r.channel);if(control)group.push({...control,condition:'Vortex · matched mean RMS'});}return group;}
  cases.forEach((r,i)=>{const option=document.createElement('option');option.value=i;option.textContent=r.pattern+' · '+r.layer+':'+r.channel;select.append(option);const row=document.createElement('div');row.className='row';row.innerHTML='<div class="label">'+option.textContent+'</div>'+group(r).map(x=>figure(x.frames.find(f=>f.label==='Flow +'+x.steps),x.condition)).join('');document.getElementById('overview').append(row);});
  function drawField(values){const c=document.getElementById('field').getContext('2d');c.clearRect(0,0,256,256);if(!values)return;for(let y=0;y<16;y++)for(let x=0;x<16;x++){const i=(y*16+x)*2,dx=values[i]/.05*7,dy=-values[i+1]/.05*7;c.strokeStyle='hsl('+((Math.atan2(-dy,dx)*180/Math.PI+360)%360)+' 80% 65%)';c.beginPath();c.moveTo(x*16+8,y*16+8);c.lineTo(x*16+8+dx,y*16+8+dy);c.stroke();}}
  function render(){const r=cases[Number(select.value)];slider.max=r.frames.length-1;const i=Math.min(Number(slider.value),r.frames.length-1),f=r.frames[i];document.getElementById('label').textContent=f.label;document.getElementById('comparison').innerHTML=group(r,document.getElementById('match-speed').checked).map(x=>figure(x.frames[i],x.condition)).join('');document.getElementById('velocity').textContent='C field: '+JSON.stringify(f.velocity);drawField(f.field);}
  select.onchange=slider.oninput=document.getElementById('match-speed').onchange=render;render();
  report.profiles.forEach(r=>{const row=document.createElement('tr');row.innerHTML='<td>'+r.pattern+' / '+r.condition+'</td><td>'+(r.layer?r.layer+':'+r.channel:'—')+'</td><td>'+r.fps.toFixed(1)+'</td><td>'+r.updatesPerSecond.toFixed(1)+'</td><td>'+r.frameP95Ms.toFixed(1)+' / '+r.frameP99Ms.toFixed(1)+'</td><td>'+(r.inferenceP50Ms?.toFixed(1)||'—')+' / '+(r.inferenceP95Ms?.toFixed(1)||'—')+'</td>';document.getElementById('performance').append(row);});
  report.clips.forEach(r=>{const div=document.createElement('div');div.innerHTML='<h3>'+r.pattern+' · '+r.layer+':'+r.channel+'</h3><video controls preload="metadata" poster="'+r.poster+'" src="'+r.filename+'"></video>';document.getElementById('clips').append(div);});report.notes.forEach(note=>{const li=document.createElement('li');li.textContent=note;document.getElementById('notes').append(li);});</script>`;
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
  console.log(`Saved review: ${output}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
