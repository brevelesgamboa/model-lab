// Cached-model ASCII + real mesh comparison. No inference or application edits.
// node tools/experiment-dream-drift-ascii.mjs [input-folder] [output-folder]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const input = path.resolve(
  process.argv[2] || "test-results/dream-drift-neon-progression",
);
const output = path.resolve(
  process.argv[3] || "test-results/dream-drift-ascii-geometry",
);
await mkdir(output, { recursive: true });
const source = JSON.parse(
  await readFile(path.join(input, "report.json"), "utf8"),
);
assert.equal(source.status, "complete");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashes = {},
  embedded = new Map();
async function texture(file) {
  if (!embedded.has(file)) {
    const bytes = await readFile(path.join(input, file));
    hashes[file] = hash(bytes);
    embedded.set(file, `data:image/png;base64,${bytes.toString("base64")}`);
  }
  return file;
}
const scenes = [];
for (const entry of source.artifacts.filter(
  (a) =>
    a.experiment?.variant === "neon" &&
    a.experiment.recipe === "mixed" &&
    [3, 5, 6].includes(a.experiment.level),
)) {
  const e = entry.experiment,
    h = e.subjectRect;
  scenes.push({
    id: `${entry.input}-level-${e.level}`,
    input: entry.input,
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
    neon: await texture(entry.texture),
    natural: await texture(`${entry.input}-progression-mixed-${e.level}.png`),
    seed: await texture(`${entry.input}-migan.png`),
  });
}
assert.equal(scenes.length, 9);
const meshSource = (
  await readFile(path.join(root, "assets/js/render/dome-mesh.js"), "utf8")
).replaceAll("export ", "");
const rendererSource = (
  await readFile(
    new URL("./dream-drift-ascii-renderer.mjs", import.meta.url),
    "utf8",
  )
)
  .replace(/^import .*;\n/m, "")
  .replaceAll("export ", "");
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dream drift · ASCII and geometry experiment</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#080c1a;color:#e6f4ff;font:15px system-ui,sans-serif}main{max-width:1250px;margin:auto;padding:24px}h1{font-size:26px;margin:0 0 8px}p{color:#aabdd2;line-height:1.55;max-width:920px}nav,.controls{display:flex;gap:14px;flex-wrap:wrap;margin:18px 0}label{display:grid;gap:5px}select,button{background:#14233c;color:#edf7ff;border:1px solid #375471;padding:10px;border-radius:6px;font:inherit}button{cursor:pointer}canvas{display:block;width:100%;aspect-ratio:4/3;max-height:75vh;object-fit:contain;background:#000;border:1px solid #375471;touch-action:none}label:has(input){display:flex;align-items:center}input{accent-color:#40efff}#status{min-height:24px;color:#63e5ed}#stills{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}figure{margin:0;background:#101a2c;border:1px solid #233b58;border-radius:7px;overflow:hidden}figure img{width:100%;display:block}figcaption{padding:9px;color:#b9d0e5;font-size:13px}.clips{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}video{width:100%;display:block}a{color:#70ecfa}@media(max-width:650px){main{padding:14px}h1{font-size:22px}#stills{grid-template-columns:1fr}canvas{max-height:none}select{max-width:100%}}
</style><main>
<h1>Dream drift · ASCII + geometry</h1>
<p>Three marmot photos, cached arches → organic model stages, and the saturated neon look. Compare image, partial ASCII and full ASCII with a plain dome, shallow relief, or neon arch frames.</p>
<nav><label>Photo<select id="photo"><option value="photo-1">1 · Close marmot</option><option value="photo-2" selected>2 · Mountain marmots</option><option value="photo-3">3 · Small “Hello” image</option></select></label>
<label>Depth<select id="level"><option value="3">3 · Unfolding</option><option value="5" selected>5 · Surreal</option><option value="6">6 · Deep dream</option></select></label>
<label>Display<select id="mode"><option value="0">Saturated image</option><option value="1" selected>Partial ASCII · clear face</option><option value="2">Full ASCII</option></select></label>
<label>Geometry<select id="geometry"><option value="0">Plain dome</option><option value="1">Shallow relief</option><option value="2" selected>Relief + neon arches</option></select></label></nav>
<canvas id="view" width="960" height="720" aria-label="Interactive dream comparison"></canvas>
<div class="controls"><button id="reset">Reset view</button><label><input type="checkbox" id="motion">Slow turn + sideways motion</label><span>Drag to look · Shift-drag to move sideways</span></div>
<p id="status">Loading…</p>
<p>The source scenes are actual saved MI-GAN/Inception outputs. ASCII, neon lighting and arch meshes are authored display treatments. Relief uses blurred image brightness, not reconstructed depth. This tests a single bounded chamber; it does not generate an endless world.</p>
<h2>Same-view comparisons</h2><div id="stills"></div>
<h2>Recorded camera motion</h2><p>Each clip uses the same slow turn and sideways movement. Pause to compare glyph detail and parallax.</p><div class="clips" id="clips"></div>
</main><script type="module">
${meshSource}
${rendererSource}
const assets=${JSON.stringify(Object.fromEntries(embedded))};
const scenes=${JSON.stringify(scenes)}.map(s=>({...s,neon:assets[s.neon],natural:assets[s.natural],seed:assets[s.seed]}));
const canvas=document.getElementById("view"), renderer=createAsciiRenderer(canvas);
const el=id=>document.getElementById(id), modes=["Saturated image","Partial ASCII","Full ASCII"], geometries=["Plain dome","Shallow relief","Relief + neon arches"];
let active,loading=false,generation=0,automation=false,drag=null;
async function selectScene(id){
  const s=scenes.find(s=>s.id===id); if(!s)throw new Error("Unknown scene");
  const ticket=++generation;loading=true;
  await renderer.load(s);if(ticket!==generation)return;
  active=s;loading=false;
  el("status").textContent="Ready · drag to look, or enable the slow camera path";
  renderer.draw();
}
function controls(){renderer.settings.mode=+el("mode").value;renderer.settings.geometry=+el("geometry").value;renderer.draw();refreshStills();}
function refreshStills(){
  if(!active)return;
  el("stills").innerHTML=modes.flatMap((m,mode)=>geometries.map((g,geometry)=>'<figure><a href="'+active.id+'-m'+mode+'-g'+geometry+'.png"><img loading="lazy" src="'+active.id+'-m'+mode+'-g'+geometry+'.png" alt="'+m+' with '+g+'"></a><figcaption>'+m+' · '+g+'</figcaption></figure>')).join("");
}
async function change(){await selectScene(el("photo").value+"-level-"+el("level").value);controls();}
for(const id of ["photo","level"])el(id).addEventListener("change",()=>change().catch(showError));
for(const id of ["mode","geometry"])el(id).addEventListener("change",controls);
function showError(e){el("status").textContent=e.message;console.error(e);}
el("reset").onclick=()=>{el("motion").checked=false;renderer.camera.reset();renderer.camera.pitch=active.pitch;renderer.draw();};
canvas.onpointerdown=e=>{drag={x:e.clientX,y:e.clientY};canvas.setPointerCapture(e.pointerId);el("motion").checked=false;};
canvas.onpointerup=()=>{drag=null;};canvas.onpointercancel=()=>{drag=null;};
canvas.onpointermove=e=>{if(!drag||loading)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag={x:e.clientX,y:e.clientY};if(e.shiftKey){renderer.camera.pan(dx*.4,dy*.4,canvas.clientHeight);}else renderer.camera.look(dx*.45,dy*.45);renderer.draw();};
function pose(t){
  renderer.camera.yaw=Math.sin(t*Math.PI*2)*.22;
  renderer.camera.pitch=active.pitch+Math.sin(t*Math.PI*4)*.025;
  renderer.camera.target=[Math.sin(t*Math.PI*2)*.32,0,Math.sin(t*Math.PI*2)*.10];
}
function tick(t){if(!automation&&!loading&&active&&el("motion").checked){pose((t%12000)/12000);renderer.draw();}requestAnimationFrame(tick);}requestAnimationFrame(tick);
const clips=[{mode:0,geometry:2},{mode:1,geometry:0},{mode:1,geometry:1},{mode:1,geometry:2},{mode:2,geometry:2}];
el("clips").innerHTML=clips.map(c=>'<figure><video controls loop muted playsinline preload="none" src="motion-m'+c.mode+'-g'+c.geometry+'.webm"></video><figcaption>'+modes[c.mode]+' · '+geometries[c.geometry]+'</figcaption></figure>').join("");
window.experiment={renderer,scenes,selectScene,pose,get active(){return active;},set automation(v){automation=v;}};
await change();window.experimentReady=true;
</script></html>`;
const galleryPath = path.join(output, "index.html");
await writeFile(galleryPath, html);
console.log(`Built self-contained live gallery with ${scenes.length} scenes`);

const browser = await chromium.launch({
  args: [
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=vulkan",
    "--enable-features=Vulkan",
    "--enable-gpu",
  ],
});
const page = await browser.newPage({ viewport: { width: 1250, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.exposeFunction("saveAsciiArtifact", async (file, base64) => {
    assert.equal(path.basename(file), file);
    await writeFile(path.join(output, file), Buffer.from(base64, "base64"));
  });
  await page.goto(`file://${galleryPath}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.experimentReady, { timeout: 30000 });
  const result = await page.evaluate(async () => {
    const e = window.experiment,
      r = e.renderer,
      canvas = document.getElementById("view");
    e.automation = true;
    canvas.width = 640;
    canvas.height = 480;
    const encode = async (blob) =>
      new Promise((resolve) => {
        const f = new FileReader();
        f.onload = () => resolve(f.result.split(",")[1]);
        f.readAsDataURL(blob);
      });
    const png = () =>
      new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const save = async (name) =>
      window.saveAsciiArtifact(name, await encode(await png()));
    const delta = (a, b) => {
      let sum = 0,
        max = 0,
        changed = 0;
      for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        sum += d;
        max = Math.max(max, d);
        if (d) changed++;
      }
      return {
        meanByte: sum / a.length,
        maxByte: max,
        changedChannels: changed,
      };
    };
    const frames = [],
      checks = [],
      timings = [];
    for (const s of e.scenes) {
      await e.selectScene(s.id);
      for (let geometry = 0; geometry < 3; geometry++) {
        r.settings.geometry = geometry;
        r.settings.mode = 0;
        r.draw();
        const reference = r.pixels();
        for (let mode = 0; mode < 3; mode++) {
          r.settings.mode = mode;
          r.draw();
          const pixels = r.pixels();
          const start = performance.now();
          r.draw();
          r.pixels();
          timings.push(performance.now() - start);
          assertEqual(r.pixels(), pixels, "paused redraw");
          r.camera.yaw = 0.22;
          r.draw();
          r.camera.yaw = 0;
          r.draw();
          assertEqual(r.pixels(), pixels, "turn away and return");
          const file = s.id + "-m" + mode + "-g" + geometry + ".png";
          await save(file);
          const change = delta(reference, pixels);
          frames.push({
            scene: s.id,
            mode,
            geometry,
            file,
            changeFromImage: change,
          });
          if (mode === 1) {
            // Project protected interior points through the same sphere and camera.
            const h = s.head,
              { view, projection } = r.camera.matrices(4 / 3);
            let tested = 0,
              max = 0;
            for (let iy = 2; iy <= 8; iy++)
              for (let ix = 2; ix <= 8; ix++) {
                const u = h.x + (h.width * ix) / 10,
                  v = 1 - h.y - (h.height * iy) / 10;
                const lon = (u - 0.5) * Math.PI * 2,
                  lat = (v - 0.5) * Math.PI;
                const p = [
                  Math.sin(lon) * Math.cos(lat) * 5,
                  Math.sin(lat) * 5,
                  -Math.cos(lon) * Math.cos(lat) * 5,
                  1,
                ];
                const mul = (m, p) =>
                  [0, 1, 2, 3].map(
                    (i) =>
                      m[i] * p[0] +
                      m[4 + i] * p[1] +
                      m[8 + i] * p[2] +
                      m[12 + i] * p[3],
                  );
                const clip = mul(projection, mul(view, p));
                if (clip[3] <= 0) continue;
                const x = Math.floor((clip[0] / clip[3] + 1) * 320),
                  y = Math.floor((clip[1] / clip[3] + 1) * 240);
                if (x < 0 || x >= 640 || y < 0 || y >= 480) continue;
                const at = (y * 640 + x) * 4;
                for (let c = 0; c < 3; c++)
                  max = Math.max(
                    max,
                    Math.abs(pixels[at + c] - reference[at + c]),
                  );
                tested++;
              }
            checks.push({
              scene: s.id,
              geometry,
              headSamples: tested,
              headMaxByte: max,
            });
          }
        }
      }
    }
    function assertEqual(a, b, label) {
      const d = delta(a, b);
      if (d.maxByte !== 0) throw new Error(label + ": " + JSON.stringify(d));
    }
    await e.selectScene("photo-2-level-5");
    r.settings.mode = 1;
    const parallax = [];
    let flatCenter, flatOffset;
    for (let geometry = 0; geometry < 3; geometry++) {
      r.settings.geometry = geometry;
      r.camera.target = [0, 0, 0];
      r.draw();
      const a = r.pixels();
      r.camera.target = [0.32, 0, 0];
      r.draw();
      const b = r.pixels();
      if (geometry === 0) {
        flatCenter = a;
        flatOffset = b;
      }
      parallax.push({
        geometry,
        translationChange: delta(a, b),
        differenceFromFlatAtCenter: delta(flatCenter, a),
        differenceFromFlatAtOffset: delta(flatOffset, b),
      });
    }
    const extension = r.gl.getExtension("WEBGL_debug_renderer_info");
    return {
      frames,
      checks,
      parallax,
      synchronizedDrawReadbackMs: timings,
      pausedRedrawExact: true,
      turnReturnExact: true,
      renderer: extension
        ? r.gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
        : r.gl.getParameter(r.gl.RENDERER),
      glError: r.gl.getError(),
    };
  });
  console.log(
    `Captured ${result.frames.length} comparisons; recording five identical camera paths`,
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
    ].find((s) => MediaRecorder.isTypeSupported(s));
    if (!mime) throw new Error("WebM recording unavailable");
    const clips = [];
    for (const [mode, geometry] of [
      [0, 2],
      [1, 0],
      [1, 1],
      [1, 2],
      [2, 2],
    ]) {
      r.settings.mode = mode;
      r.settings.geometry = geometry;
      e.pose(0);
      r.draw();
      const stream = canvas.captureStream(0),
        track = stream.getVideoTracks()[0],
        chunks = [];
      const recorder = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: 3500000,
      });
      const stopped = new Promise((resolve) => (recorder.onstop = resolve));
      recorder.ondataavailable = (x) => {
        if (x.data.size) chunks.push(x.data);
      };
      recorder.start();
      const start = performance.now();
      for (let i = 0; i <= 90; i++) {
        e.pose(i / 90);
        r.draw();
        track.requestFrame();
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(1, start + (i + 1) * 66.6667 - performance.now()),
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
      const file = "motion-m" + mode + "-g" + geometry + ".webm";
      await window.saveAsciiArtifact(file, encoded);
      clips.push({
        file,
        mode,
        geometry,
        framesRequested: 91,
        bytes: blob.size,
        mime,
        elapsedMs: performance.now() - start,
      });
    }
    e.pose(0);
    r.settings.mode = 1;
    r.settings.geometry = 2;
    r.draw();
    return clips;
  });
  const sorted = result.synchronizedDrawReadbackMs.toSorted((a, b) => a - b);
  // Data URLs keep decoded video frames origin-clean on a file:// gallery.
  const playbackSources = await Promise.all(
    motion.map(async (clip) => ({
      ...clip,
      url: `data:video/webm;base64,${(await readFile(path.join(output, clip.file))).toString("base64")}`,
    })),
  );
  const playback = await page.evaluate(async (clips) => {
    const sheet = document.createElement("canvas");
    sheet.width = 1280;
    sheet.height = clips.length * 268;
    const ctx = sheet.getContext("2d");
    ctx.fillStyle = "#0a1020";
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    const decoded = [];
    async function event(target, name, action) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out waiting for " + name)),
          10000,
        );
        target.addEventListener(
          name,
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        target.addEventListener(
          "error",
          () => {
            clearTimeout(timer);
            reject(new Error("Video decode failed"));
          },
          { once: true },
        );
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
      const times = [0.2, 1.6, 3.2, 5.9];
      for (let col = 0; col < times.length; col++) {
        await event(video, "seeked", () => {
          video.currentTime = times[col];
        });
        ctx.drawImage(video, col * 320, row * 268, 320, 240);
        ctx.fillStyle = "#b9e6f2";
        ctx.font = "13px monospace";
        ctx.fillText(
          "m" + clip.mode + " g" + clip.geometry + " · " + times[col] + "s",
          col * 320 + 8,
          row * 268 + 258,
        );
      }
      decoded.push({
        file: clip.file,
        width: video.videoWidth,
        height: video.videoHeight,
        seekTimes: times,
        decoded: true,
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
    await window.saveAsciiArtifact("motion-contact.png", encoded);
    return decoded;
  }, playbackSources);
  const unchanged = await Promise.all(
    Object.entries(hashes).map(async ([file, before]) => ({
      file,
      unchanged: hash(await readFile(path.join(input, file))) === before,
    })),
  );
  assert(unchanged.every((x) => x.unchanged));
  assert.equal(result.glError, 0);
  assert.equal(errors.length, 0);
  assert(result.checks.every((c) => c.headSamples > 0 && c.headMaxByte === 0));
  assert(
    result.frames
      .filter((f) => f.mode === 0)
      .every((f) => f.changeFromImage.maxByte === 0),
  );
  assert(
    result.frames
      .filter((f) => f.mode !== 0)
      .every((f) => f.changeFromImage.meanByte > 1),
  );
  assert(playback.every((c) => c.width === 640 && c.height === 480));
  const report = {
    status: "complete",
    branch: execFileSync("git", ["branch", "--show-current"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    configuration: {
      sources: 3,
      levels: [3, 5, 6],
      recipe: "mixed",
      modes: ["saturated image", "partial ASCII", "full ASCII"],
      geometry: [
        "sphere radius 5",
        "blurred brightness relief up to 0.65",
        "relief plus two swept-tube arches and depth-tested floor",
      ],
      glyphGrid: [192, 64],
      glyphs: " .,:;-=+*ox%#@",
      inferenceRuns: 0,
      productionChanges: false,
      camera: {
        verticalFovDegrees: 85,
        yawAmplitudeRadians: 0.22,
        lateralAmplitude: 0.32,
        forwardAmplitude: 0.1,
      },
      resolution: [640, 480],
    },
    ...result,
    motion,
    playback,
    errors,
    textureHashes: hashes,
    sourceTexturesUnchanged: true,
    codeHashes: Object.fromEntries(
      await Promise.all(
        [
          "tools/dream-drift-ascii-renderer.mjs",
          "tools/experiment-dream-drift-ascii.mjs",
          "assets/js/render/dome-mesh.js",
        ].map(async (file) => [
          file,
          hash(await readFile(path.join(root, file))),
        ]),
      ),
    ),
    timingSummary: {
      medianMs: sorted[Math.floor(sorted.length * 0.5)],
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
      note: "Synchronized draw + CPU readback on one desktop GPU, not application frame-rate or generation throughput",
    },
    limits: [
      "Cached six-stage model chain; no new world generation or endless traversal.",
      "Brightness relief is not a depth estimate; arches/floor are authored geometry.",
      "ASCII and neon are display effects, not model-generated glitches.",
      "World UV anchoring is deterministic; aliasing under motion still needs visual review, especially near poles and at a distance.",
      "No collision or doorway traversal is implemented by this isolated renderer.",
    ],
  };
  await page.screenshot({ path: path.join(output, "gallery-preview.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  assert(mobile.scrollWidth <= mobile.viewport);
  await page.screenshot({ path: path.join(output, "gallery-mobile.png") });
  report.galleryValidation = {
    mobile,
    embeddedTextures: embedded.size,
    referencedStills: 81,
    decodedClips: playback.length,
  };
  for (const file of [
    path.join(output, "report.json"),
    path.join(root, "verification/dream-drift-ascii-geometry.json"),
  ])
    await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        stills: result.frames.length,
        motion: motion.length,
        headChecks: result.checks.length,
        glError: result.glError,
        timing: report.timingSummary,
        mobile,
        gallery: galleryPath,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
