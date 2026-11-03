// First gateway refinement: image-derived color, shared rain and full hex.
// node tools/experiment-dream-drift-hex.mjs [output-folder]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import {
  RAIN_GLSL,
  IMAGE_COLOR_GLSL,
  GLYPH_SETS,
} from "./dream-drift-ascii-renderer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(
  process.argv[2] || "test-results/dream-drift-image-hex",
);
const input = path.resolve(
  process.argv[3] || "test-results/dream-drift-neon-progression",
);
await mkdir(output, { recursive: true });
execFileSync(
  process.execPath,
  [
    path.join(root, "tools/experiment-dream-drift-ascii.mjs"),
    input,
    output,
    "--gallery-only",
  ],
  { stdio: "inherit" },
);
const gallery = path.join(output, "index.html"),
  hash = (b) => createHash("sha256").update(b).digest("hex");
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
  await page.exposeFunction("saveHexArtifact", async (file, base64) => {
    assert.equal(path.basename(file), file);
    await writeFile(path.join(output, file), Buffer.from(base64, "base64"));
  });
  await page.goto(pathToFileURL(gallery).href);
  await page.waitForFunction(() => window.experimentReady);
  const captures = await page.evaluate(async () => {
    const e = window.experiment,
      r = e.renderer,
      canvas = document.getElementById("view");
    e.automation = true;
    canvas.width = 640;
    canvas.height = 480;
    const digest = async (p) =>
      [...new Uint8Array(await crypto.subtle.digest("SHA-256", p))]
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
    const save = async (file) => {
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      const encoded = await new Promise((resolve) => {
        const f = new FileReader();
        f.onload = () => resolve(f.result.split(",")[1]);
        f.readAsDataURL(blob);
      });
      await window.saveHexArtifact(file, encoded);
    };
    const frames = [],
      headChecks = [],
      glyphSets = {};
    for (const scene of e.scenes) {
      await e.selectScene(scene.id);
      for (const glyphSet of ["hex", "technical", "classic"])
        for (const paletteMode of [0, 1]) {
          Object.assign(r.settings, {
            glyphSet,
            paletteMode,
            mode: 2,
            geometry: 2,
            archStyle: 1,
            animMode: 4,
            animSpeed: 1.8,
            vibrancy: 1.25,
            columns: 320,
            rows: 112,
          });
          r.draw(3.25);
          const a = r.pixels(),
            first = await digest(a);
          r.draw(3.25);
          if ((await digest(r.pixels())) !== first)
            throw new Error("Paused draw changed");
          glyphSets[glyphSet] = r.glyphs;
          const file = scene.id + "-" + glyphSet + "-p" + paletteMode + ".png";
          await save(file);
          frames.push({
            scene: scene.id,
            glyphSet,
            paletteMode,
            file,
            sha256: first,
          });
          if (r.gl.getError()) throw new Error("WebGL error after " + file);
        }
      Object.assign(r.settings, {
        glyphSet: "hex",
        paletteMode: 0,
        geometry: 0,
        mode: 0,
      });
      r.draw(3.25);
      const photo = r.pixels();
      r.settings.mode = 1;
      r.draw(3.25);
      const woven = r.pixels();
      const h = scene.head,
        { view, projection } = r.camera.matrices(4 / 3);
      let max = 0,
        samples = 0;
      const mul = (m, p) =>
        [0, 1, 2, 3].map(
          (i) =>
            m[i] * p[0] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[12 + i] * p[3],
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
            max = Math.max(max, Math.abs(woven[at + c] - photo[at + c]));
          samples++;
        }
      headChecks.push({ scene: scene.id, samples, maxByte: max });
    }
    // Exercise every style/mode with all palettes, glyph sets and vibrancy extremes.
    await e.selectScene("photo-2-level-5");
    canvas.width = 320;
    canvas.height = 240;
    let combinations = 0;
    for (let archStyle = 0; archStyle < 6; archStyle++)
      for (let animMode = 0; animMode < 5; animMode++)
        for (const glyphSet of ["hex", "technical", "classic"])
          for (const paletteMode of [0, 1])
            for (const vibrancy of [0.7, 1.25, 1.6]) {
              Object.assign(r.settings, {
                archStyle,
                animMode,
                glyphSet,
                paletteMode,
                vibrancy,
                geometry: 2,
              });
              r.draw(2);
              r.pixels();
              if (r.gl.getError()) throw new Error("Combination failed");
              combinations++;
            }
    Object.assign(r.settings, { animMode: 0, geometry: 2, archStyle: 1 });
    r.draw(0);
    const a = await digest(r.pixels());
    r.draw(10);
    if ((await digest(r.pixels())) !== a)
      throw new Error("Static mode did not freeze");
    return {
      frames,
      headChecks,
      glyphSets,
      combinations,
      pausedExact: true,
      staticModeExact: true,
    };
  });
  console.log(
    `Captured ${captures.frames.length} views; ${captures.combinations} shader combinations passed`,
  );

  // Probe the actual shared GPU kernels for hue/luma fidelity and falling direction.
  const kernels = await page.evaluate(
    ({ rain, color }) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const gl = canvas.getContext("webgl2");
      const program = gl.createProgram();
      for (const [type, source] of [
        [
          gl.VERTEX_SHADER,
          "#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}",
        ],
        [
          gl.FRAGMENT_SHADER,
          "#version 300 es\nprecision highp float;\nuniform vec2 cell,density;uniform float clock,saturation,probe;uniform vec3 inputColor;out vec4 outputColor;\n" +
            rain +
            color +
            "\nvoid main(){outputColor=probe<.5?vec4(vec3(rainSignal(cell,density,clock)),1.):vec4(imageVibrance(inputColor,saturation),1.);}",
        ],
      ]) {
        const s = gl.createShader(type);
        gl.shaderSource(s, source);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(s));
        gl.attachShader(program, s);
        gl.deleteShader(s);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program));
      gl.useProgram(program);
      gl.bindVertexArray(gl.createVertexArray());
      const u = Object.fromEntries(
        ["cell", "density", "clock", "saturation", "probe", "inputColor"].map(
          (k) => [k, gl.getUniformLocation(program, k)],
        ),
      );
      gl.uniform2f(u.density, 320, 112);
      const read = () => {
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const p = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
        return [...p].slice(0, 3);
      };
      const sample = (x, y, t) => {
        gl.uniform1f(u.probe, 0);
        gl.uniform2f(u.cell, x, y);
        gl.uniform1f(u.clock, t);
        return read()[0];
      };
      let downwardMax = 0,
        wrapMax = 0;
      for (const speed of [0.5, 1, 1.8])
        for (const column of [3, 47, 120, 251])
          for (const y of [10, 35, 70, 100]) {
            const a = sample(column, y, 2 * speed),
              b = sample(column, y - 1, (2 + 1 / (112 * 0.18 * speed)) * speed),
              c = sample(column, y, 2 * speed + 1 / 0.18);
            downwardMax = Math.max(downwardMax, Math.abs(a - b));
            wrapMax = Math.max(wrapMax, Math.abs(a - c));
          }
      let lumaError = 0,
        grayError = 0;
      const luma = (c) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
      const colors = [
        [0.72, 0.4, 0.16],
        [0.12, 0.55, 0.82],
        [0.21, 0.56, 0.25],
        [0.5, 0.5, 0.5],
        [0.04, 0.04, 0.04],
        [0.97, 0.9, 0.83],
      ];
      const samples = [];
      gl.uniform1f(u.probe, 1);
      for (const c of colors)
        for (const saturation of [0.7, 1, 1.25, 1.6]) {
          gl.uniform3fv(u.inputColor, c);
          gl.uniform1f(u.saturation, saturation);
          const result = read().map((n) => n / 255);
          lumaError = Math.max(lumaError, Math.abs(luma(result) - luma(c)));
          if (c[0] === c[1] && c[1] === c[2])
            grayError = Math.max(
              grayError,
              Math.max(...result) - Math.min(...result),
            );
          samples.push({ input: c, saturation, result });
        }
      const glError = gl.getError();
      gl.deleteProgram(program);
      return {
        downwardMaxByte: downwardMax,
        cycleWrapMaxByte: wrapMax,
        maxLumaError: lumaError,
        maxGrayChroma: grayError,
        samples,
        glError,
      };
    },
    { rain: RAIN_GLSL, color: IMAGE_COLOR_GLSL },
  );
  assert(kernels.downwardMaxByte <= 1 && kernels.cycleWrapMaxByte <= 1);
  assert(kernels.maxLumaError < 0.003);
  assert.equal(kernels.maxGrayChroma, 0);
  assert.equal(kernels.glError, 0);

  // At an origin-locked view, the gateway and dome see identical scene directions.
  // Their changing pixels must agree up to the gateway's fixed rim/exposure shading.
  const sync = await page.evaluate(async () => {
    const e = window.experiment,
      r = e.renderer,
      canvas = document.getElementById("view");
    await e.selectScene("photo-2-level-5");
    canvas.width = 640;
    canvas.height = 480;
    Object.assign(r.settings, {
      glyphSet: "hex",
      paletteMode: 0,
      mode: 2,
      archStyle: 1,
      animMode: 4,
      animSpeed: 1.8,
      vibrancy: 1.25,
      columns: 320,
      rows: 112,
      breathing: 0,
    });
    const { view, projection } = r.camera.matrices(4 / 3),
      mul = (m, p) =>
        [0, 1, 2, 3].map(
          (i) =>
            m[i] * p[0] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[12 + i] * p[3],
        );
    const points = [];
    for (const x of [-1.72, 1.72])
      for (const y of [-0.9, -0.6, -0.3, 0]) points.push([x, y, -2.725]);
    for (let i = 2; i < 19; i++) {
      const a = (i * Math.PI) / 20;
      points.push([Math.cos(a) * 1.72, 0.12 + Math.sin(a) * 1.72, -2.725]);
    }
    const locations = points
      .map((p) => {
        const q = mul(projection, mul(view, [...p, 1]));
        return [
          Math.floor((q[0] / q[3] + 1) * 320),
          Math.floor((q[1] / q[3] + 1) * 240),
        ];
      })
      .filter(([x, y]) => x > 0 && x < 640 && y > 0 && y < 480);
    const dome = [],
      gateway = [];
    for (const t of [0, 0.35, 0.7, 1.05, 1.4, 1.75]) {
      r.settings.geometry = 0;
      r.draw(t);
      dome.push(r.pixels());
      r.settings.geometry = 2;
      r.draw(t);
      gateway.push(r.pixels());
    }
    const samples = [];
    for (const [x, y] of locations) {
      const at = (y * 640 + x) * 4;
      let ab = 0,
        aa = 0;
      for (let i = 1; i < dome.length; i++)
        for (let c = 0; c < 3; c++) {
          const a = dome[i][at + c] - dome[0][at + c],
            b = gateway[i][at + c] - gateway[0][at + c];
          aa += a * a;
          ab += a * b;
        }
      if (aa < 200) continue;
      const gain = ab / aa;
      let error = 0;
      for (let i = 1; i < dome.length; i++)
        for (let c = 0; c < 3; c++) {
          const a = dome[i][at + c] - dome[0][at + c],
            b = gateway[i][at + c] - gateway[0][at + c];
          error += (b - gain * a) ** 2;
        }
      samples.push({ x, y, gain, rmsByte: Math.sqrt(error / 15) });
    }
    r.settings.breathing = 1;
    return {
      samples,
      qualified: samples.filter(
        (s) => s.gain >= 0.5 && s.gain <= 0.92 && s.rmsByte < 3,
      ).length,
    };
  });
  assert(
    sync.qualified >= Math.max(6, sync.samples.length * 0.75),
    JSON.stringify(sync),
  );
  console.log(
    `Shared rain verified at ${sync.qualified}/${sync.samples.length} gateway surface samples; recording motion`,
  );

  const motion = await page.evaluate(async () => {
    const e = window.experiment,
      r = e.renderer,
      canvas = document.getElementById("view");
    await e.selectScene("photo-2-level-5");
    Object.assign(r.settings, {
      glyphSet: "hex",
      paletteMode: 0,
      mode: 1,
      geometry: 2,
      archStyle: 1,
      animMode: 4,
      animSpeed: 1.8,
      vibrancy: 1.25,
      columns: 320,
      rows: 112,
      breathing: 1,
    });
    const mime = [
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm",
      ].find((s) => MediaRecorder.isTypeSupported(s)),
      clips = [];
    if (!mime) throw new Error("No WebM encoder");
    for (const moving of [false, true]) {
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
      for (let i = 0; i <= 180; i++) {
        if (moving) e.pose(i / 180);
        r.draw(i / 15);
        track.requestFrame();
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(1, start + ((i + 1) * 1000) / 15 - performance.now()),
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
      const file = moving ? "hex-rain-camera.webm" : "hex-rain-still.webm";
      await window.saveHexArtifact(file, encoded);
      clips.push({ file, bytes: blob.size, seconds: 12, framesRequested: 181 });
    }
    e.pose(0);
    r.draw(0);
    return clips;
  });
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
    ctx.fillStyle = "#172431";
    ctx.fillRect(0, 0, 960, sheet.height);
    const decoded = [];
    async function event(target, name, action) {
      await new Promise((resolve, reject) => {
        const clear = () => {
          clearTimeout(timer);
          target.removeEventListener(name, done);
          target.removeEventListener("error", fail);
        };
        const done = () => {
            clear();
            resolve();
          },
          fail = () => {
            clear();
            reject(new Error("Video decode failed"));
          };
        const timer = setTimeout(() => {
          clear();
          reject(new Error("Video decode timeout"));
        }, 10000);
        target.addEventListener(name, done);
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
      for (const [column, time] of [0.2, 6, 11.8].entries()) {
        await event(video, "seeked", () => {
          video.currentTime = time;
        });
        ctx.drawImage(video, column * 320, row * 268, 320, 240);
        ctx.fillStyle = "#d8eaf5";
        ctx.font = "12px monospace";
        ctx.fillText(
          clip.file + " · " + time + "s",
          column * 320 + 5,
          row * 268 + 258,
        );
      }
      decoded.push({
        file: clip.file,
        width: video.videoWidth,
        height: video.videoHeight,
        seekTimes: [0.2, 6, 11.8],
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
    await window.saveHexArtifact("motion-contact.png", encoded);
    return decoded;
  }, playbackSources);
  assert(playback.every((v) => v.width === 640 && v.height === 480));
  const cost = await page.evaluate(async () => {
    const r = window.experiment.renderer,
      canvas = document.getElementById("view"),
      gl = r.gl,
      ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    if (!ext) return { status: "GPU timer unavailable" };
    canvas.width = 960;
    canvas.height = 720;
    const rows = [];
    for (const [columns, lines] of [
      [240, 80],
      [320, 112],
      [416, 144],
    ]) {
      r.settings.columns = columns;
      r.settings.rows = lines;
      const queries = [];
      for (let i = 0; i < 36; i++) {
        const q = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        r.draw(3.25);
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        queries.push(q);
      }
      gl.flush();
      const deadline = performance.now() + 5000;
      while (
        !gl.getQueryParameter(queries.at(-1), gl.QUERY_RESULT_AVAILABLE) &&
        performance.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 2));
      if (
        gl.getParameter(ext.GPU_DISJOINT_EXT) ||
        !gl.getQueryParameter(queries.at(-1), gl.QUERY_RESULT_AVAILABLE)
      )
        throw new Error("Invalid GPU timing");
      const samples = queries
        .slice(8)
        .map((q) => gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6)
        .toSorted((a, b) => a - b);
      queries.forEach((q) => gl.deleteQuery(q));
      rows.push({
        columns,
        width: 960,
        height: 720,
        medianGpuMs: samples[14],
        p95GpuMs: samples[26],
      });
    }
    r.settings.columns = 320;
    r.settings.rows = 112;
    return {
      status: "measured",
      rows,
      note: "One desktop GPU, rendering only; no generation work or application FPS claim",
    };
  });
  // Actual controls, including atlas changes after a texture upload and pausing.
  for (const glyphSet of Object.keys(GLYPH_SETS)) {
    await page.selectOption("#glyphSet", glyphSet);
    const chars = await page.evaluate(() =>
      window.experiment.renderer.glyphs.map((g) => g.character).join(""),
    );
    assert.deepEqual([...chars].sort(), [...GLYPH_SETS[glyphSet]].sort());
  }
  await page.selectOption("#glyphSet", "hex");
  await page.selectOption("#paletteMode", "0");
  await page.locator("#vibrancy").fill("1.4");
  assert.equal(
    await page.evaluate(() => window.experiment.renderer.settings.vibrancy),
    1.4,
  );
  await page.evaluate(() => {
    window.experiment.automation = false;
  });
  await page.uncheck("#living");
  const held = await page.evaluate(() => window.experiment.time);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.experiment.time), held);
  await page.check("#living");
  await page.waitForTimeout(250);
  assert((await page.evaluate(() => window.experiment.time)) > held);
  await page.locator("#vibrancy").fill("1.25");
  await page.evaluate(() => {
    window.experiment.automation = true;
    const c = document.getElementById("view");
    c.width = 960;
    c.height = 720;
    window.experiment.renderer.settings.vibrancy = 1.25;
    window.experiment.renderer.draw(0);
    window.scrollTo(0, 0);
  });
  await page.evaluate(async () => {
    const canvas = document.getElementById("view"),
      blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
    const encoded = await new Promise((resolve) => {
      const f = new FileReader();
      f.onload = () => resolve(f.result.split(",")[1]);
      f.readAsDataURL(blob);
    });
    await window.saveHexArtifact("hero.png", encoded);
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
  assert(captures.headChecks.every((h) => h.samples > 0 && h.maxByte === 0));
  assert.equal(errors.length, 0);
  const files = [
    "tools/dream-drift-ascii-renderer.mjs",
    "tools/dream-drift-ascii-viewer.mjs",
    "tools/dream-drift-ascii-gallery.html",
    "tools/experiment-dream-drift-hex.mjs",
  ];
  const report = {
    status: "complete",
    configuration: {
      glyphs: GLYPH_SETS,
      defaultGlyphSet: "hex",
      palette: "Natural model image with luma-preserving saturation",
      sharedRain:
        "One scene projection, density, clock, speed and periodic envelope for both surfaces",
      breathing:
        "Woven frame width ±1.2%, height ±0.6%, feet anchored; no new echoes",
      inferenceRuns: 0,
    },
    ...captures,
    kernels,
    sync,
    motion,
    playback,
    cost,
    mobile,
    errors,
    codeHashes: Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [
          file,
          hash(await readFile(path.join(root, file))),
        ]),
      ),
    ),
  };
  const json = JSON.stringify(report, null, 2) + "\n";
  await writeFile(path.join(output, "report.json"), json);
  await writeFile(
    path.join(root, "verification/dream-drift-image-hex.json"),
    json,
  );
  console.log(
    JSON.stringify(
      {
        gallery,
        frames: captures.frames.length,
        combinations: captures.combinations,
        headChecks: captures.headChecks.length,
        sync: sync.qualified,
        kernels: { ...kernels, samples: undefined },
        mobile,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
