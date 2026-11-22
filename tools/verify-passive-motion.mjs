// Passive transport only: no Inception, training, or app settings changes.
// node tools/verify-passive-motion.mjs [output] [--quick|--long] [--size=128]
// Optional --speed=0.05 and --seeds=1,17,42 restrict a follow-up stress run.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { createStaticServer } from "../server.mjs";

const args = process.argv.slice(2);
const output = path.resolve(
  args.find((arg) => !arg.startsWith("--")) ||
    "/tmp/latent-field-passive-motion",
);
const quick = args.includes("--quick"),
  long = args.includes("--long");
const size = Number(
  args.find((arg) => arg.startsWith("--size="))?.split("=")[1] || 256,
);
const seedArgument = args.find((arg) => arg.startsWith("--seeds="));
const speedArgument = args.find((arg) => arg.startsWith("--speed="));
const seeds = seedArgument
  ? seedArgument.split("=")[1].split(",").map(Number)
  : quick || long
    ? [17]
    : [1, 17, 42];
const speeds = speedArgument
  ? [Number(speedArgument.split("=")[1])]
  : quick || long
    ? [0.1]
    : [0.05, 0.1, 0.25];
const activeSteps = long ? 8192 : quick ? 1024 : 2048;
const recoverySteps = long ? 1024 : quick ? 256 : 512;
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(output, "frames"), { recursive: true });
const server = await createStaticServer(root);
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const browser = await chromium.launch({
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=gl", "--enable-gpu"],
});
const results = [],
  errors = [],
  inceptionRequests = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1300, height: 1000 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("/models/inception/"))
      inceptionRequests.push(request.url());
  });
  await page.goto(
    `http://127.0.0.1:${server.address().port}/runtime-check.html`,
  );
  const environment = await page.evaluate(async (size) => {
    const { TextureNcaRuntime } =
      await import("/assets/js/models/neural-growth/runtime.js");
    const { validateCheckpoint } =
      await import("/assets/js/models/neural-growth/reference.js");
    const models = Object.fromEntries(
      await Promise.all(
        ["membrane-field", "xeno-reef"].map(async (id) => [
          id,
          validateCheckpoint(
            await (
              await fetch(`/models/neural-growth/organic-structures/${id}.json`)
            ).json(),
          ),
        ]),
      ),
    );
    window.motionTest = { TextureNcaRuntime, models };
    const runtime = new TextureNcaRuntime({
      model: models["membrane-field"],
      size,
      seed: 17,
    });
    const ext = runtime.gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = runtime.gl.getParameter(
      ext?.UNMASKED_RENDERER_WEBGL || runtime.gl.RENDERER,
    );
    runtime.dispose();
    return { renderer, userAgent: navigator.userAgent };
  }, size);
  console.log(
    JSON.stringify({
      environment,
      size,
      activeSteps,
      recoverySteps,
      seeds,
      speeds,
    }),
  );
  for (const pattern of ["membrane-field", "xeno-reef"])
    for (const seed of seeds) {
      const configurations = [
        { field: "off", speed: 0 },
        ...["wave", "vortex"].flatMap((field) =>
          speeds.map((speed) => ({ field, speed })),
        ),
      ];
      for (const config of configurations) {
        const result = await page.evaluate(
          async ({
            pattern,
            seed,
            size,
            config,
            activeSteps,
            recoverySteps,
          }) => {
            const { TextureNcaRuntime, models } = window.motionTest;
            const runtime = new TextureNcaRuntime({
              model: models[pattern],
              size,
              seed,
            });
            const runtimes = [runtime];
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = size;
            const frames = [],
              recovery = [],
              timing = [];
            const center = [Math.round(size * 0.36), Math.round(size * 0.37)];
            const radius = Math.max(9, Math.round(size * 0.07));
            let tracer = center.slice();
            function velocity(x, y) {
              const a = ((x + 0.5) * Math.PI * 2) / size,
                b = ((y + 0.5) * Math.PI * 2) / size;
              return config.field === "wave"
                ? [config.speed * Math.sin(b), 0]
                : config.field === "vortex"
                  ? [
                      config.speed * Math.sin(a) * Math.cos(b),
                      -config.speed * Math.cos(a) * Math.sin(b),
                    ]
                  : [0, 0];
            }
            function moveTracer() {
              const v = velocity(...tracer),
                mid = velocity(tracer[0] + v[0] / 2, tracer[1] + v[1] / 2);
              tracer = tracer.map((value, i) => (value + mid[i] + size) % size);
            }
            function advect(target) {
              if (config.speed) target.advect(config);
            }
            function image(target) {
              if (seed !== 17) return null;
              target.draw(canvas, {
                palette: "native",
                displayFilter: "smooth",
              });
              return canvas.toDataURL("image/png");
            }
            function metrics(target, reference = null) {
              const state = target.readState();
              const healthy = reference?.readState();
              const sums = Array(12).fill(0),
                seconds = Array(12).fill(0);
              const local = Array(3).fill(0),
                localSeconds = Array(3).fill(0);
              let high = 0,
                clipped = 0,
                count = 0,
                difference = 0;
              const rgb = (cell, c) =>
                Math.max(
                  0,
                  Math.min(1, ((state[cell * 12 + c] - 127) * 2) / 255 + 0.5),
                );
              for (let y = 0; y < size; y++)
                for (let x = 0; x < size; x++) {
                  const cell = y * size + x;
                  let dx = Math.abs(x - tracer[0]),
                    dy = Math.abs(y - tracer[1]);
                  dx = Math.min(dx, size - dx);
                  dy = Math.min(dy, size - dy);
                  const inCore = dx * dx + dy * dy < (radius * 0.35) ** 2;
                  if (inCore) count++;
                  for (let c = 0; c < 12; c++) {
                    const v =
                      c < 3
                        ? rgb(cell, c)
                        : ((state[cell * 12 + c] - 127) * 4) / 255;
                    sums[c] += v;
                    seconds[c] += v * v;
                    if (c < 3) {
                      clipped += v === 0 || v === 1 ? 1 : 0;
                      const neighbors =
                        (rgb(y * size + ((x + 1) % size), c) +
                          rgb(y * size + ((x + size - 1) % size), c) +
                          rgb(((y + 1) % size) * size + x, c) +
                          rgb(((y + size - 1) % size) * size + x, c)) /
                        4;
                      high += (v - neighbors) ** 2;
                      if (inCore) {
                        local[c] += v;
                        localSeconds[c] += v * v;
                      }
                      if (healthy)
                        difference +=
                          (((state[cell * 12 + c] - healthy[cell * 12 + c]) *
                            2) /
                            255) **
                          2;
                    }
                  }
                }
              const n = size * size;
              const channels = sums.map((sum, c) => ({
                mean: sum / n,
                std: Math.sqrt(Math.max(0, seconds[c] / n - (sum / n) ** 2)),
              }));
              const rgbStd = Math.sqrt(
                channels
                  .slice(0, 3)
                  .reduce((sum, channel) => sum + channel.std ** 2, 0) / 3,
              );
              return {
                channels,
                rgbStd,
                highFrequencyRms: Math.sqrt(high / (n * 3)),
                roughness: Math.sqrt(high / (n * 3)) / (rgbStd || 1),
                clippedFraction: clipped / (n * 3),
                woundCoreStd: Math.sqrt(
                  local.reduce(
                    (sum, v, c) =>
                      sum +
                      Math.max(0, localSeconds[c] / count - (v / count) ** 2),
                    0,
                  ) / 3,
                ),
                differenceFromHealthy: healthy
                  ? Math.sqrt(difference / (n * 3))
                  : null,
              };
            }
            function clone(state) {
              const target = new TextureNcaRuntime({
                model: models[pattern],
                size,
                seed,
              });
              runtimes.push(target);
              target.writeState(state);
              // Restore the deterministic sparse-update clock without replaying GPU work.
              for (let i = 0; i < runtime.steps * 2; i++)
                target.layout.random();
              target.steps = runtime.steps;
              return target;
            }
            try {
              runtime.step(128);
              runtime.step(128);
              frames.push({
                label: "Mature starting field",
                activeStep: 0,
                metrics: metrics(runtime),
                image: image(runtime),
              });
              const milestones = new Set([
                64,
                256,
                1024,
                2048,
                4096,
                8192,
                activeSteps,
              ]);
              let batch = performance.now();
              for (let step = 1; step <= activeSteps; step++) {
                runtime.step(1, { dreamStrength: 0 });
                advect(runtime);
                if (milestones.has(step)) {
                  const values = metrics(runtime);
                  timing.push({
                    activeStep: step,
                    elapsedMs: performance.now() - batch,
                  });
                  frames.push({
                    label: `Flow +${step}`,
                    activeStep: step,
                    metrics: values,
                    image: image(runtime),
                  });
                  batch = performance.now();
                }
              }
              const before = runtime.readState();
              const healthy = clone(before);
              const wound = before.slice();
              for (let y = 0; y < size; y++)
                for (let x = 0; x < size; x++) {
                  if (Math.hypot(x - center[0], y - center[1]) <= radius)
                    wound.fill(
                      127,
                      (y * size + x) * 12,
                      (y * size + x + 1) * 12,
                    );
                }
              runtime.writeState(wound);
              const transportOnly = clone(wound);
              const capture = (step) =>
                recovery.push({
                  step,
                  tracer: tracer.slice(),
                  damaged: metrics(runtime, healthy),
                  healthy: metrics(healthy),
                  transportOnly: metrics(transportOnly),
                  images: [
                    image(healthy),
                    image(runtime),
                    image(transportOnly),
                  ],
                });
              capture(0);
              const recoveryMilestones = new Set([
                16,
                64,
                128,
                256,
                512,
                1024,
                recoverySteps,
              ]);
              let allocation;
              for (let step = 1; step <= recoverySteps; step++) {
                runtime.step();
                advect(runtime);
                healthy.step();
                advect(healthy);
                advect(transportOnly);
                moveTracer();
                // The transport shader is compiled lazily on each fresh runtime.
                if (step === 1)
                  allocation = runtimes.map(
                    (target) => target.getStats().resources,
                  );
                if (recoveryMilestones.has(step)) capture(step);
              }
              const stableAllocations = runtimes.every(
                (target, i) =>
                  JSON.stringify(target.getStats().resources) ===
                  JSON.stringify(allocation[i]),
              );
              const rngMatched = runtime.lastOffset.every(
                (value, i) => value === healthy.lastOffset[i],
              );
              const glErrors = runtimes.map((target) => target.gl.getError());
              return {
                pattern,
                seed,
                size,
                ...config,
                activeSteps,
                recoverySteps,
                radius,
                woundCenter: center,
                frames,
                recovery,
                timing,
                stableAllocations,
                rngMatched,
                glErrors,
              };
            } finally {
              for (const target of runtimes) target.dispose();
              if (
                runtimes.some((target) =>
                  Object.values(target.getStats().resources).some(
                    (value) => value !== 0,
                  ),
                )
              )
                throw new Error("Runtime resources not released");
            }
          },
          { pattern, seed, size, config, activeSteps, recoverySteps },
        );
        const index = results.length;
        async function saveImage(data, name) {
          if (!data) return null;
          const filename = `frames/${index}-${name}.png`;
          await writeFile(
            path.join(output, filename),
            Buffer.from(data.split(",")[1], "base64"),
          );
          return filename;
        }
        for (const [i, frame] of result.frames.entries())
          frame.image = await saveImage(frame.image, `flow-${i}`);
        for (const [i, frame] of result.recovery.entries())
          frame.images = await Promise.all(
            frame.images.map((image, branch) =>
              saveImage(image, `recovery-${i}-${branch}`),
            ),
          );
        assert.ok(
          result.glErrors.every((error) => error === 0),
          "WebGL error during passive flow",
        );
        assert.ok(
          result.rngMatched,
          "Recovery control update schedules differ",
        );
        assert.ok(result.stableAllocations, "Resources grew during recovery");
        results.push(result);
        await writeFile(
          path.join(output, "report.json"),
          JSON.stringify(
            {
              environment,
              activeSteps,
              recoverySteps,
              size,
              seeds,
              speeds,
              errors,
              inceptionRequests,
              results,
            },
            null,
            2,
          ),
        );
        const final = result.recovery.at(-1);
        console.log(
          JSON.stringify({
            pattern,
            seed,
            ...config,
            rgbStd: result.frames.at(-1).metrics.rgbStd,
            roughness: result.frames.at(-1).metrics.roughness,
            recoveredCore: final.damaged.woundCoreStd,
            healthyCore: final.healthy.woundCoreStd,
            transportOnlyCore: final.transportOnly.woundCoreStd,
          }),
        );
      }
    }
  assert.deepEqual(errors, []);
  assert.deepEqual(inceptionRequests, []);
  const report = {
    environment,
    size,
    seeds,
    speeds,
    activeSteps,
    recoverySteps,
    warmupSteps: 256,
    notes: [
      "Speed is cells per NCA update, not seconds; one transport pass follows each NCA update.",
      "The vortex field is a smooth periodic array of counter-rotating vortices. Wave flow is horizontal sinusoidal shear.",
      "All twelve state channels are bilinearly transported in the existing RGBA8 format. No Inception inference is used.",
      "Hard damage erases all twelve channels in a circular region. Recovery metrics follow the advected wound center.",
      "Transport-only control receives identical flow passes but no NCA updates. It distinguishes repair from transport and interpolation.",
      "Wall times are offline batch measurements, not interactive FPS. Numerical diffusion and byte rounding may change texture morphology.",
    ],
    errors,
    inceptionRequests,
    results,
  };
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  const html = String.raw`<!doctype html><meta charset="utf-8"><title>Passive NCA motion stress test</title>
  <style>body{font:15px system-ui;background:#101218;color:#e4e8ed;margin:24px}p{max-width:1100px;line-height:1.5}select,button{font:inherit;background:#252b38;color:inherit;padding:8px;border:1px solid #566077}figure{margin:0}figcaption{padding:5px;color:#b7c7d7}img{width:256px;max-width:100%}.row{display:flex;gap:16px;margin:20px 0}.label{width:220px;flex-shrink:0}table{border-collapse:collapse}td,th{border:1px solid #566077;padding:8px;text-align:left}#frame{width:450px}pre{white-space:pre-wrap}</style>
  <h1>Passive NCA motion: structure and recovery</h1><p id="environment"></p><p>Wave and periodic vortex fields transport all 12 channels. Inception is disconnected. Each case runs 256 warmup updates followed by ${activeSteps} active-flow updates, then ${recoverySteps} recovery updates. Speed is cells per NCA update.</p><p>Recovery comparisons show an undamaged NCA, a damaged NCA healing during flow, and the same damaged state receiving flow without NCA updates. Measurements follow the moving wound center.</p>
  <select id="case"></select><p><button id="play">Play recovery frames</button> <input id="frame" type="range" min="0" value="0"><span id="label"></span></p><div class="row" id="recovery"></div><pre id="metrics"></pre><h2>Seed 17: final active-flow fields</h2><p>Each row shows the flow-off control and the active-flow field at the same simulation age.</p><div id="overview"></div><h2>All seeds: structural statistics before damage</h2><table id="stats"><tr><th>Model / seed</th><th>Field</th><th>Speed</th><th>Spatial RGB std</th><th>Roughness / contrast</th></tr></table><script>
  const report=${JSON.stringify(report).replaceAll("<", "\\u003c")};
  const cases=report.results.filter(r=>r.seed===17),select=document.getElementById('case'),slider=document.getElementById('frame');
  document.getElementById('environment').textContent=report.environment.renderer+' · '+report.size+'² grid';
  function figure(src,text){return '<figure><img src="'+src+'"><figcaption>'+text+'</figcaption></figure>';}
  cases.forEach((r,i)=>{const option=document.createElement('option');option.value=i;option.textContent=r.pattern+' · '+r.field+' · '+r.speed;select.append(option);if(r.field==='off')return;const off=cases.find(x=>x.pattern===r.pattern&&x.field==='off'),row=document.createElement('div');row.className='row';row.innerHTML='<div class="label">'+option.textContent+'</div>'+figure(off.frames.at(-1).image,'Flow off')+figure(r.frames.at(-1).image,'Active flow');document.getElementById('overview').append(row);});
  report.results.forEach(r=>{const m=r.frames.at(-1).metrics,tr=document.createElement('tr');tr.innerHTML='<td>'+r.pattern+' / '+r.seed+'</td><td>'+r.field+'</td><td>'+r.speed+'</td><td>'+m.rgbStd.toFixed(4)+'</td><td>'+m.roughness.toFixed(4)+'</td>';document.getElementById('stats').append(tr);});
  function render(){const r=cases[Number(select.value)];slider.max=r.recovery.length-1;const f=r.recovery[Number(slider.value)];document.getElementById('label').textContent='Recovery +'+f.step;document.getElementById('recovery').innerHTML=f.images.map((src,i)=>figure(src,['Undamaged NCA + flow','Damaged NCA + flow','Damaged + flow only'][i])).join('');document.getElementById('metrics').textContent='Moving wound center: '+f.tracer.map(v=>v.toFixed(2)).join(', ')+' | Spatial contrast at center: healthy '+f.healthy.woundCoreStd.toFixed(5)+' · healing '+f.damaged.woundCoreStd.toFixed(5)+' · transport only '+f.transportOnly.woundCoreStd.toFixed(5);}
  select.onchange=()=>{slider.value=0;render();};slider.oninput=render;let timer;document.getElementById('play').onclick=()=>{if(timer){clearInterval(timer);timer=null;return;}timer=setInterval(()=>{slider.value=(Number(slider.value)+1)%(Number(slider.max)+1);render();},400);};render();</script>`;
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
