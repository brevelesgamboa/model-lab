// Rework the ASCII experiment using cached model stages and a continuous surface.
// node tools/experiment-dream-drift-flow.mjs [input-folder] [output-folder]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const input = path.resolve(
  process.argv[2] || "test-results/dream-drift-neon-progression",
);
const output = path.resolve(
  process.argv[3] || "test-results/dream-drift-color-flow",
);
await mkdir(output, { recursive: true });
const source = JSON.parse(
  await readFile(path.join(input, "report.json"), "utf8"),
);
assert.equal(source.status, "complete");
const hash = (b) => createHash("sha256").update(b).digest("hex"),
  hashes = {},
  assets = {};
async function texture(file) {
  if (!assets[file]) {
    const bytes = await readFile(path.join(input, file));
    hashes[file] = hash(bytes);
    assets[file] = `data:image/png;base64,${bytes.toString("base64")}`;
  }
  return file;
}
const scenes = [];
for (const a of source.artifacts.filter(
  (a) =>
    a.experiment?.variant === "neon" &&
    a.experiment.recipe === "mixed" &&
    [3, 5, 6].includes(a.experiment.level),
)) {
  const e = a.experiment,
    h = e.subjectRect,
    previous = e.level - 1;
  scenes.push({
    id: `${a.input}-level-${e.level}`,
    input: a.input,
    level: e.level,
    pitch: e.frontPitch,
    head: {
      x: h.x / 1024,
      y: h.y / 512,
      width: h.width / 1024,
      height: h.height / 512,
      featherX: h.feather / 1024,
      featherY: h.feather / 512,
    },
    previous: await texture(
      `${a.input}-progression-mixed-${previous}-neon.png`,
    ),
    current: await texture(a.texture),
    previousNatural: await texture(
      `${a.input}-progression-mixed-${previous}.png`,
    ),
    currentNatural: await texture(
      `${a.input}-progression-mixed-${e.level}.png`,
    ),
    seed: await texture(`${a.input}-migan.png`),
  });
}
assert.equal(scenes.length, 9);
const moduleFiles = [
  "assets/js/render/dome-mesh.js",
  "tools/dream-drift-flow-renderer.mjs",
];
const inline = (
  await Promise.all(
    moduleFiles.map(async (f) =>
      (await readFile(path.join(root, f), "utf8"))
        .replace(/^import .*;\n/m, "")
        .replaceAll("export ", ""),
    ),
  )
).join("\n");
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dream drift · Living color ASCII</title>
<style>*{box-sizing:border-box}body{margin:0;background:#11212f;color:#eaf8ff;font:15px system-ui,sans-serif}main{max-width:1240px;margin:auto;padding:24px}h1{font-size:27px;margin:0 0 8px}p{max-width:970px;color:#bbd0db;line-height:1.55}nav,.controls{display:flex;gap:14px;flex-wrap:wrap;margin:18px 0}label{display:grid;gap:5px}select,button{background:#203e50;border:1px solid #4e7c8a;color:#efffff;padding:10px;border-radius:7px;font:inherit;cursor:pointer}input{accent-color:#7df7e1}label:has(input){display:flex;align-items:center}canvas{display:block;width:100%;height:auto;max-height:75vh;aspect-ratio:4/3;object-fit:contain;touch-action:none;background:#203e50;border:1px solid #4e7c8a;border-radius:10px}#status{min-height:24px;color:#9df5e6}.stills,.clips{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}figure{margin:0;background:#1b3445;border:1px solid #3b6573;border-radius:8px;overflow:hidden}img,video{display:block;width:100%}figcaption{font-size:13px;padding:10px;color:#c6e8ee}a{color:#9df5e6}@media(max-width:700px){main{padding:14px}h1{font-size:23px}.stills,.clips{grid-template-columns:1fr}canvas{max-height:none}select{max-width:100%}}</style>
<main><h1>Dream drift · Living color ASCII</h1><p>Smaller colored characters woven into the image, with a gentle change in shape and color. The scene itself provides the space around you.</p>
<nav><label>Photo<select id="photo"><option value="photo-1">1 · Close marmot</option><option value="photo-2" selected>2 · Mountain marmots</option><option value="photo-3">3 · Small “Hello” image</option></select></label>
<label>Depth<select id="level"><option value="3">3 · Unfolding</option><option value="5" selected>5 · Surreal</option><option value="6">6 · Deep dream</option></select></label>
<label>Color treatment<select id="mode"><option value="0">Image</option><option value="1" selected>Woven ASCII · clear face</option><option value="2">Colored ASCII throughout</option></select></label>
<label>Characters<select id="density"><option value="240">Small</option><option value="320" selected>Smaller</option><option value="416">Finest</option></select></label>
<label>Surface<select id="geometry"><option value="0">Smooth dome</option><option value="1">Image relief</option><option value="2" selected>Breathing relief</option></select></label></nav>
<canvas id="view" width="960" height="720" aria-label="Animated colored ASCII dream"></canvas>
<div class="controls"><button id="reset">Reset view</button><label><input id="living" type="checkbox" checked>Slow change</label><label><input id="motion" type="checkbox">Slow camera</label><span>Drag to look · Shift-drag to move</span></div><p id="status">Loading…</p>
<p>Slow change blends two neighboring saved model stages over a 40-second cycle. The colored strokes and gentle surface motion are shader effects. Pause it at any point to inspect the image.</p>
<h2>Size and color comparisons</h2><div id="stills" class="stills"></div><h2>Before and after · depth 5</h2><div id="comparison" class="stills"></div><h2>Motion studies</h2><div id="clips" class="clips"></div>
<p><a href="../dream-drift-ascii-geometry/index.html">Previous experiment</a> · This is an isolated chamber study using your cached model outputs.</p></main><script type="module">
${inline}
const assets=${JSON.stringify(assets)},scenes=${JSON.stringify(scenes)}.map(s=>({...s,previous:assets[s.previous],current:assets[s.current],previousNatural:assets[s.previousNatural],currentNatural:assets[s.currentNatural],seed:assets[s.seed]}));
const canvas=document.getElementById("view"),renderer=createFlowRenderer(canvas),el=id=>document.getElementById(id),densities={240:80,320:112,416:144};
let active,automation=false,loading=false,sceneGeneration=0,time=0,last,lastPaint=0,drag;
const draw=()=>renderer.draw(time);
async function selectScene(id){const s=scenes.find(s=>s.id===id);if(!s)throw new Error("Unknown scene");const ticket=++sceneGeneration;loading=true;await renderer.load(s);if(ticket!==sceneGeneration)return;active=s;time=0;loading=false;draw();el("status").textContent="Ready · color and form evolve slowly";}
function refresh(){if(!active)return;el("stills").innerHTML=[1,2].flatMap(mode=>[240,320,416].map(columns=>'<figure><a href="'+active.id+'-m'+mode+'-c'+columns+'.png"><img loading="lazy" src="'+active.id+'-m'+mode+'-c'+columns+'.png" alt="Colored ASCII at '+columns+' columns"></a><figcaption>'+(mode===1?'Woven ASCII · clear face':'Colored ASCII throughout')+' · '+columns+' columns</figcaption></figure>')).join("");el("comparison").innerHTML='<figure><img loading="lazy" src="previous-'+active.input+'-level-5-m2-g0.png" alt="Previous full ASCII"><figcaption>Previous full ASCII</figcaption></figure><figure><img loading="lazy" src="'+active.input+'-level-5-m2-c320.png" alt="New colored ASCII"><figcaption>New colored ASCII</figcaption></figure>';}
function controls(){renderer.settings.mode=+el("mode").value;renderer.settings.geometry=+el("geometry").value;renderer.settings.columns=+el("density").value;renderer.settings.rows=densities[renderer.settings.columns];draw();refresh();}
async function change(){await selectScene(el("photo").value+'-level-'+el("level").value);controls();}
for(const id of ["photo","level"])el(id).onchange=()=>change().catch(e=>{el("status").textContent=e.message;console.error(e);});
for(const id of ["mode","geometry","density"])el(id).onchange=controls;
el("reset").onclick=()=>{el("motion").checked=false;renderer.camera.reset();renderer.camera.pitch=active.pitch;draw();};
canvas.onpointerdown=e=>{drag={x:e.clientX,y:e.clientY};canvas.setPointerCapture(e.pointerId);el("motion").checked=false;};canvas.onpointerup=()=>{drag=null;};canvas.onpointercancel=()=>{drag=null;};
canvas.onpointermove=e=>{if(!drag||loading)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag={x:e.clientX,y:e.clientY};if(e.shiftKey)renderer.camera.pan(dx*.4,dy*.4,canvas.clientHeight);else renderer.camera.look(dx*.45,dy*.45);draw();};
function pose(t){renderer.camera.yaw=Math.sin(t*Math.PI*2)*.22;renderer.camera.pitch=active.pitch+Math.sin(t*Math.PI*4)*.025;renderer.camera.target=[Math.sin(t*Math.PI*2)*.32,0,Math.sin(t*Math.PI*2)*.10];}
function tick(now){const delta=last===undefined?0:Math.min(.1,(now-last)/1000);last=now;if(!automation&&!loading&&active){if(el("living").checked)time+=delta;if(el("motion").checked)pose((now%18000)/18000);if((el("motion").checked||el("living").checked&&now-lastPaint>=1000/30)){draw();lastPaint=now;}}requestAnimationFrame(tick);}requestAnimationFrame(tick);
const clips=[{name:"living",label:"Still camera · slow color and model change"},{name:"camera",label:"Slow camera · breathing relief"},{name:"finest",label:"Finest characters · colored ASCII throughout"}];
el("clips").innerHTML=clips.map(c=>'<figure><video controls muted playsinline preload="none" src="'+c.name+'.webm"></video><figcaption>'+c.label+'</figcaption></figure>').join("");
window.experiment={renderer,scenes,selectScene,pose,get active(){return active;},get time(){return time;},set time(v){time=v;},set automation(v){automation=v;}};await change();window.experimentReady=true;
</script></html>`;
const gallery = path.join(output, "index.html");
await writeFile(gallery, html);
console.log("Built live color-flow gallery");
const browser = await chromium.launch({
  args: [
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=vulkan",
    "--enable-features=Vulkan",
    "--enable-gpu",
  ],
});
const page = await browser.newPage({ viewport: { width: 1250, height: 1000 } }),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.exposeFunction("saveFlowArtifact", async (file, base64) => {
    assert.equal(path.basename(file), file);
    await writeFile(path.join(output, file), Buffer.from(base64, "base64"));
  });
  await page.goto(`file://${gallery}`);
  await page.waitForFunction(() => window.experimentReady);
  const captures = await page.evaluate(async () => {
    const e = window.experiment,
      r = e.renderer,
      canvas = document.getElementById("view");
    e.automation = true;
    canvas.width = 640;
    canvas.height = 480;
    const encode = (blob) =>
      new Promise((resolve) => {
        const f = new FileReader();
        f.onload = () => resolve(f.result.split(",")[1]);
        f.readAsDataURL(blob);
      });
    const save = async (file) =>
      window.saveFlowArtifact(
        file,
        await encode(
          await new Promise((resolve) => canvas.toBlob(resolve, "image/png")),
        ),
      );
    const delta = (a, b) => {
      let sum = 0,
        max = 0;
      for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        sum += d;
        max = Math.max(max, d);
      }
      return { meanByte: sum / a.length, maxByte: max };
    };
    const metrics = (p) => {
      let dark = 0,
        luma = 0,
        chroma = 0;
      for (let i = 0; i < p.length; i += 4) {
        const l = (p[i] * 0.2126 + p[i + 1] * 0.7152 + p[i + 2] * 0.0722) / 255;
        luma += l;
        if (l < 0.08) dark++;
        chroma +=
          Math.max(p[i], p[i + 1], p[i + 2]) -
          Math.min(p[i], p[i + 1], p[i + 2]);
      }
      return {
        darkFraction: dark / (p.length / 4),
        meanLuma: luma / (p.length / 4),
        meanChromaByte: chroma / (p.length / 4),
      };
    };
    const frames = [],
      checks = [];
    for (const scene of e.scenes) {
      await e.selectScene(scene.id);
      r.settings.geometry = 2;
      for (const [columns, rows] of [
        [240, 80],
        [320, 112],
        [416, 144],
      ]) {
        r.settings.columns = columns;
        r.settings.rows = rows;
        r.settings.mode = 0;
        r.draw(0);
        const reference = r.pixels();
        for (const mode of [1, 2]) {
          r.settings.mode = mode;
          r.draw(0);
          const p = r.pixels();
          r.draw(0);
          if (delta(p, r.pixels()).maxByte)
            throw new Error("Paused draw changed");
          r.camera.yaw = 0.22;
          r.draw(0);
          r.camera.yaw = 0;
          r.draw(0);
          if (delta(p, r.pixels()).maxByte)
            throw new Error("Camera return changed");
          const file = scene.id + "-m" + mode + "-c" + columns + ".png";
          await save(file);
          frames.push({
            scene: scene.id,
            columns,
            rows,
            mode,
            file,
            ...metrics(p),
          });
          if (mode === 1) {
            const h = scene.head,
              { view, projection } = r.camera.matrices(4 / 3);
            let max = 0,
              samples = 0;
            const mul = (m, p) =>
              [0, 1, 2, 3].map(
                (i) =>
                  m[i] * p[0] +
                  m[4 + i] * p[1] +
                  m[8 + i] * p[2] +
                  m[12 + i] * p[3],
              );
            for (let y = 2; y <= 8; y++)
              for (let x = 2; x <= 8; x++) {
                const u = h.x + (h.width * x) / 10,
                  v = 1 - h.y - (h.height * y) / 10,
                  lon = (u - 0.5) * Math.PI * 2,
                  lat = (v - 0.5) * Math.PI;
                const q = mul(
                  projection,
                  mul(view, [
                    Math.sin(lon) * Math.cos(lat) * 5,
                    Math.sin(lat) * 5,
                    -Math.cos(lon) * Math.cos(lat) * 5,
                    1,
                  ]),
                );
                if (q[3] <= 0) continue;
                const px = Math.floor((q[0] / q[3] + 1) * 320),
                  py = Math.floor((q[1] / q[3] + 1) * 240);
                if (px < 0 || px >= 640 || py < 0 || py >= 480) continue;
                const at = (py * 640 + px) * 4;
                for (let c = 0; c < 3; c++)
                  max = Math.max(max, Math.abs(p[at + c] - reference[at + c]));
                samples++;
              }
            checks.push({
              scene: scene.id,
              columns,
              headSamples: samples,
              headMaxByte: max,
            });
          }
        }
      }
    }
    await e.selectScene("photo-2-level-5");
    r.settings.mode = 1;
    r.settings.columns = 320;
    r.settings.rows = 112;
    const evolution = [];
    let previous;
    for (const time of [0, 0.016, 4, 8, 12, 20, 40]) {
      r.draw(time);
      const p = r.pixels(),
        file = "evolution-" + time + ".png";
      await save(file);
      evolution.push({
        time,
        file,
        ...metrics(p),
        changeFromPrevious: previous ? delta(previous, p) : null,
      });
      previous = p;
    }
    r.draw(0);
    const loopA = r.pixels();
    r.draw(40);
    const loopB = r.pixels();
    // The model blend loops, while glyphs/relief evolve on their own slower paths.
    r.draw(10);
    const exact = r.pixels();
    r.draw(10);
    if (delta(exact, r.pixels()).maxByte)
      throw new Error("Frozen animation changed");
    const extension = r.gl.getExtension("WEBGL_debug_renderer_info");
    return {
      frames,
      checks,
      evolution,
      pausedRedrawExact: true,
      cameraReturnExact: true,
      frozenAnimationExact: true,
      loopDifference: delta(loopA, loopB),
      glyphs: r.glyphs,
      triangles: r.triangleCount,
      glError: r.gl.getError(),
      renderer: extension
        ? r.gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
        : r.gl.getParameter(r.gl.RENDERER),
    };
  });
  console.log(
    `Captured ${captures.frames.length} size/color comparisons; recording three slow-change studies`,
  );
  const motion = await page.evaluate(async () => {
    const e = window.experiment,
      r = e.renderer,
      canvas = document.getElementById("view");
    await e.selectScene("photo-2-level-5");
    const mime = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error("No WebM encoder");
    const clips = [];
    for (const name of ["living", "camera", "finest"]) {
      r.settings.mode = name === "finest" ? 2 : 1;
      r.settings.columns = name === "finest" ? 416 : 320;
      r.settings.rows = name === "finest" ? 144 : 112;
      r.settings.geometry = 2;
      e.pose(0);
      r.draw(0);
      const stream = canvas.captureStream(0),
        track = stream.getVideoTracks()[0],
        chunks = [];
      const recorder = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: 4000000,
      });
      recorder.ondataavailable = (x) => {
        if (x.data.size) chunks.push(x.data);
      };
      const stopped = new Promise((resolve) => (recorder.onstop = resolve));
      recorder.start();
      const start = performance.now();
      for (let i = 0; i <= 192; i++) {
        if (name === "camera") e.pose(i / 192);
        r.draw(i / 12);
        track.requestFrame();
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(1, start + ((i + 1) * 1000) / 12 - performance.now()),
          ),
        );
      }
      recorder.stop();
      await stopped;
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: mime });
      const encoded = await new Promise((resolve) => {
        const f = new FileReader();
        f.onload = () => resolve(f.result.split(",")[1]);
        f.readAsDataURL(blob);
      });
      const file = name + ".webm";
      await window.saveFlowArtifact(file, encoded);
      clips.push({
        file,
        name,
        framesRequested: 193,
        seconds: 16,
        bytes: blob.size,
        mime,
      });
    }
    e.pose(0);
    r.settings.mode = 1;
    r.settings.columns = 320;
    r.settings.rows = 112;
    e.time = 0;
    r.draw(0);
    return clips;
  });
  console.log(
    "Motion recorded; checking darkness, controls and rendering cost",
  );
  const playbackSources = await Promise.all(
    motion.map(async (clip) => ({
      ...clip,
      url: `data:video/webm;base64,${(await readFile(path.join(output, clip.file))).toString("base64")}`,
    })),
  );
  const playback = await page.evaluate(async (clips) => {
    const sheet = document.createElement("canvas");
    sheet.width = 960;
    sheet.height = clips.length * 268;
    const ctx = sheet.getContext("2d");
    ctx.fillStyle = "#173141";
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    const decoded = [];
    async function event(target, name, action) {
      await new Promise((resolve, reject) => {
        const clean = () => {
          clearTimeout(timer);
          target.removeEventListener(name, success);
          target.removeEventListener("error", fail);
        };
        const success = () => {
            clean();
            resolve();
          },
          fail = () => {
            clean();
            reject(new Error("Video decode failed: " + name));
          };
        const timer = setTimeout(() => {
          clean();
          reject(new Error("Video decode timeout: " + name));
        }, 10000);
        target.addEventListener(name, success);
        target.addEventListener("error", fail);
        action();
      });
    }
    for (let row = 0; row < clips.length; row++) {
      const clip = clips[row],
        video = document.createElement("video");
      video.muted = true;
      await event(video, "loadedmetadata", () => {
        video.src = clip.url;
        video.load();
      });
      for (const [column, time] of [0.2, 8, 15.8].entries()) {
        await event(video, "seeked", () => {
          video.currentTime = time;
        });
        ctx.drawImage(video, column * 320, row * 268, 320, 240);
        ctx.fillStyle = "#c5f6ef";
        ctx.font = "13px monospace";
        ctx.fillText(
          clip.name + " · " + time + "s",
          column * 320 + 8,
          row * 268 + 258,
        );
      }
      decoded.push({
        file: clip.file,
        width: video.videoWidth,
        height: video.videoHeight,
        seekTimes: [0.2, 8, 15.8],
      });
      video.removeAttribute("src");
      video.load();
    }
    const blob = await new Promise((resolve) =>
      sheet.toBlob(resolve, "image/png"),
    );
    const encoded = await new Promise((resolve) => {
      const f = new FileReader();
      f.onload = () => resolve(f.result.split(",")[1]);
      f.readAsDataURL(blob);
    });
    await window.saveFlowArtifact("motion-contact.png", encoded);
    return decoded;
  }, playbackSources);
  // Compare pixels against the preceding experiment without changing its files.
  const previousDirectory = path.join(
    root,
    "test-results/dream-drift-ascii-geometry",
  );
  const oldImages = [];
  for (const photo of ["photo-1", "photo-2", "photo-3"])
    for (const mode of [1, 2]) {
      const file = `${photo}-level-5-m${mode}-g0.png`,
        bytes = await readFile(path.join(previousDirectory, file));
      oldImages.push({
        photo,
        mode,
        url: `data:image/png;base64,${bytes.toString("base64")}`,
      });
      await copyFile(
        path.join(previousDirectory, file),
        path.join(output, `previous-${file}`),
      );
    }
  const comparison = await page.evaluate(async (entries) => {
    const e = window.experiment,
      r = e.renderer,
      canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext("2d"),
      rows = [];
    for (const entry of entries) {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = entry.url;
      });
      ctx.drawImage(image, 0, 0);
      const old = ctx.getImageData(0, 0, 640, 480).data;
      await e.selectScene(entry.photo + "-level-5");
      r.settings.mode = entry.mode;
      r.settings.geometry = 0;
      r.settings.columns = 320;
      r.settings.rows = 112;
      r.draw(0);
      const current = r.pixels();
      const measure = (data) => {
        let count = 0;
        for (let i = 0; i < data.length; i += 4)
          if (
            (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) /
              255 <
            0.08
          )
            count++;
        return count / (data.length / 4);
      };
      rows.push({
        photo: entry.photo,
        mode: entry.mode,
        oldDarkFraction: measure(old),
        newDarkFraction: measure(current),
      });
    }
    return rows;
  }, oldImages);
  async function benchmark(target, old) {
    return target.evaluate(
      async ({ old }) => {
        const r = window.experiment.renderer,
          canvas = document.getElementById("view"),
          profiles = old
            ? [
                { name: "previous-no-arches", mode: 1, geometry: 0 },
                { name: "previous-arches", mode: 1, geometry: 2 },
              ]
            : [
                { name: "color-240", columns: 240, rows: 80 },
                { name: "color-320", columns: 320, rows: 112 },
                { name: "color-416", columns: 416, rows: 144 },
                {
                  name: "color-320-frozen",
                  columns: 320,
                  rows: 112,
                  animated: false,
                },
              ];
        const rows = [];
        for (const [width, height] of [
          [640, 480],
          [960, 720],
        ]) {
          canvas.width = width;
          canvas.height = height;
          const timings = profiles.map(() => []);
          for (let round = 0; round < 45; round++)
            for (let j = 0; j < profiles.length; j++) {
              const i = (j + round) % profiles.length,
                p = profiles[i];
              Object.assign(
                r.settings,
                { mode: 1, geometry: 2, animated: true },
                p,
              );
              const start = performance.now();
              r.draw(8);
              r.pixels();
              const elapsed = performance.now() - start;
              if (round >= 10) timings[i].push(elapsed);
            }
          const ext = r.gl.getExtension("EXT_disjoint_timer_query_webgl2");
          const gpu = profiles.map(() => []),
            queries = [];
          let gpuStatus = ext ? "available" : "extension unavailable";
          if (ext) {
            for (let round = 0; round < 24; round++)
              for (let j = 0; j < profiles.length; j++) {
                const i = (j + round) % profiles.length,
                  p = profiles[i],
                  q = r.gl.createQuery();
                Object.assign(
                  r.settings,
                  { mode: 1, geometry: 2, animated: true },
                  p,
                );
                r.gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
                r.draw(8);
                r.gl.endQuery(ext.TIME_ELAPSED_EXT);
                queries.push({ q, i });
              }
            r.gl.flush();
            const deadline = performance.now() + 5000;
            while (
              !r.gl.getQueryParameter(
                queries.at(-1).q,
                r.gl.QUERY_RESULT_AVAILABLE,
              ) &&
              performance.now() < deadline
            )
              await new Promise((resolve) => setTimeout(resolve, 2));
            const ready = r.gl.getQueryParameter(
                queries.at(-1).q,
                r.gl.QUERY_RESULT_AVAILABLE,
              ),
              disjoint = r.gl.getParameter(ext.GPU_DISJOINT_EXT);
            gpuStatus = disjoint
              ? "disjoint measurement discarded"
              : !ready
                ? "query timed out"
                : "available";
            for (const { q, i } of queries) {
              if (ready && !disjoint)
                gpu[i].push(r.gl.getQueryParameter(q, r.gl.QUERY_RESULT) / 1e6);
              r.gl.deleteQuery(q);
            }
          }
          profiles.forEach((p, i) => {
            const sorted = timings[i].toSorted((a, b) => a - b);
            const gpuSorted = gpu[i].toSorted((a, b) => a - b);
            rows.push({
              profile: p.name,
              width,
              height,
              medianMs: sorted[17],
              p95Ms: sorted[33],
              samples: sorted,
              gpuStatus,
              gpuMedianMs: gpuSorted.length ? gpuSorted[12] : null,
              gpuP95Ms: gpuSorted.length ? gpuSorted[22] : null,
              gpuSamples: gpuSorted,
            });
          });
        }
        return rows;
      },
      { old },
    );
  }
  await page.evaluate(async () => {
    window.experiment.automation = true;
    await window.experiment.selectScene("photo-2-level-5");
  });
  const cost = await benchmark(page, false);
  const oldPage = await browser.newPage();
  await oldPage.goto(
    new URL(`file://${path.join(previousDirectory, "index.html")}`).href,
  );
  await oldPage.waitForFunction(() => window.experimentReady);
  await oldPage.evaluate(() => {
    window.experiment.automation = true;
  });
  cost.push(...(await benchmark(oldPage, true)));
  await oldPage.close();
  // Validate controls on the live page, including pause/resume without a time jump.
  await page.evaluate(() => {
    const e = window.experiment;
    e.renderer.settings.animated = true;
    e.automation = false;
    e.time = 8;
  });
  await page.uncheck("#living");
  const paused = await page.evaluate(() => window.experiment.time);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.experiment.time), paused);
  await page.check("#living");
  await page.waitForTimeout(250);
  const resumed = await page.evaluate(() => window.experiment.time);
  assert(resumed > paused && resumed - paused < 0.6);
  const cadence = await page.evaluate(async () => {
    const r = window.experiment.renderer,
      original = r.draw;
    let count = 0;
    r.draw = (...args) => {
      count++;
      return original(...args);
    };
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const measuredFps = count / ((performance.now() - start) / 1000);
    document.getElementById("living").checked = false;
    count = 0;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const pausedDraws = count;
    r.draw = original;
    document.getElementById("living").checked = true;
    return { measuredFps, pausedDraws };
  });
  assert(cadence.measuredFps > 0 && cadence.measuredFps <= 32);
  assert.equal(cadence.pausedDraws, 0);
  await page.selectOption("#photo", "photo-3");
  await page.waitForFunction(
    () => window.experiment.active.id === "photo-3-level-5",
  );
  await page.selectOption("#density", "416");
  await page.selectOption("#mode", "2");
  await page.selectOption("#geometry", "1");
  const selected = await page.evaluate(() => ({
    ...window.experiment.renderer.settings,
  }));
  assert.equal(selected.columns, 416);
  assert.equal(selected.mode, 2);
  assert.equal(selected.geometry, 1);
  await page.selectOption("#photo", "photo-2");
  await page.waitForFunction(
    () => window.experiment.active.id === "photo-2-level-5",
  );
  await page.selectOption("#density", "320");
  await page.selectOption("#mode", "1");
  await page.selectOption("#geometry", "2");
  await page.evaluate(() => {
    window.experiment.automation = true;
    window.experiment.time = 0;
    const canvas = document.getElementById("view");
    canvas.width = 960;
    canvas.height = 720;
    window.experiment.renderer.draw(0);
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: path.join(output, "gallery-preview.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const mobile = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert(mobile.scrollWidth <= mobile.width);
  await page.screenshot({ path: path.join(output, "gallery-mobile.png") });
  assert.equal(captures.glError, 0);
  assert.equal(errors.length, 0);
  assert.equal(
    await page.evaluate(() => window.experiment.renderer.gl.getError()),
    0,
  );
  assert(
    captures.checks.every((c) => c.headSamples > 0 && c.headMaxByte === 0),
  );
  assert(comparison.every((c) => c.newDarkFraction < c.oldDarkFraction));
  assert(playback.every((c) => c.width === 640 && c.height === 480));
  assert(captures.evolution[1].changeFromPrevious.meanByte < 0.1);
  assert(
    captures.evolution[4].changeFromPrevious.meanByte >
      captures.evolution[1].changeFromPrevious.meanByte * 10,
  );
  for (const [file, before] of Object.entries(hashes))
    assert.equal(hash(await readFile(path.join(input, file))), before);
  const report = {
    status: "complete",
    configuration: {
      inferenceRuns: 0,
      sources: 3,
      levels: [3, 5, 6],
      columns: [240, 320, 416],
      rows: [80, 112, 144],
      idleAnimationFpsCap: 30,
      modelBlend: "Previous and selected cached stage, eased 40-second cycle",
      geometry:
        "One continuous sphere with protected-face brightness relief and smooth radial breathing, no added structures",
      glyphs:
        "Coverage-sorted array layers with independent mipmaps and continuous adjacent-glyph cross-fades",
    },
    ...captures,
    comparison,
    motion,
    playback,
    cost,
    costNote:
      "medianMs/p95Ms include synchronized draw plus CPU readback; GPU query timings are separately reported when available. Desktop only, not application FPS or mobile cost.",
    controls: {
      pauseHoldsTime: true,
      resumeContinues: true,
      selectors: true,
      cadence,
      mobile,
    },
    textureHashes: hashes,
    sourceTexturesUnchanged: true,
    errors,
    codeHashes: Object.fromEntries(
      await Promise.all(
        [...moduleFiles, "tools/experiment-dream-drift-flow.mjs"].map(
          async (file) => [file, hash(await readFile(path.join(root, file)))],
        ),
      ),
    ),
    limits: [
      "Uses two cached model stages per scene, not live generation.",
      "Brightness relief is an artistic hypothesis, not reconstructed depth.",
      "No endless traversal or collision system.",
    ],
  };
  for (const file of [
    path.join(output, "report.json"),
    path.join(root, "verification/dream-drift-color-flow.json"),
  ])
    await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        gallery,
        frames: captures.frames.length,
        headChecks: captures.checks.length,
        comparison,
        cost: cost.map(({ samples: _samples, ...row }) => row),
        mobile,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
