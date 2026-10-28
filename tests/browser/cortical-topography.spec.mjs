import { test, expect } from "@playwright/test";

async function openTopography(page) {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.abort(),
  );
  await page.goto("/");
  await page.evaluate(async () => {
    const { CorticalTopographyModel } =
      await import("/assets/js/models/cortical-topography.js");
    const render = CorticalTopographyModel.prototype.render;
    CorticalTopographyModel.prototype.render = function (...args) {
      window.__topography = this;
      return render.apply(this, args);
    };
  });
  await page.locator("#model-select").selectOption("cortical-topography");
  await page.waitForFunction(() => Boolean(window.__topography?.graphics));
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
}

async function photo(page, width, name) {
  const encoded = await page.evaluate((width) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = 32;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createLinearGradient(0, 0, width, 32);
    gradient.addColorStop(0, "#203780");
    gradient.addColorStop(1, "#f2b450");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, 32);
    ctx.fillStyle = "#ed5a75";
    ctx.fillRect(width / 4, 8, width / 3, 16);
    return canvas.toDataURL("image/png").split(",")[1];
  }, width);
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(encoded, "base64"),
  };
}

async function fakeDepth(context, fail = false) {
  await context.addInitScript(() => {
    const Original = window.Worker;
    window.__depthWorkerCount = 0;
    window.__depthTerminations = 0;
    window.Worker = class extends Original {
      constructor(url, options) {
        super(url, options);
        this.isDepth = String(url).includes("depth-estimator.worker");
        if (this.isDepth) window.__depthWorkerCount++;
      }
      terminate() {
        if (this.isDepth) window.__depthTerminations++;
        return super.terminate();
      }
    };
  });
  await context.route("**/depth-estimator.worker.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `self.onmessage=({data:{bitmap}})=>{
      const width=bitmap.width; bitmap.close();
      self.postMessage({type:'status',message:'Estimating depth once…'});
      setTimeout(()=>{
        if(${fail}) {self.postMessage({type:'error',error:'Offline fixture'});return;}
        const depth=new Float32Array(width===64 ? [0,0,0,0] : [0,1,0.25,0.75]);
        self.postMessage({type:'result',width:2,height:2,depth,backend:'fixture',inferenceMs:4},[depth.buffer]);
      },width===64 ? 1600 : 300);
    };`,
    }),
  );
}

test("the indexed surface renders all wave modes, orbits/pans/zooms while paused and preserves camera on resize", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const modelRequests = [];
  page.on("request", (r) => {
    if (r.url().includes("huggingface.co")) modelRequests.push(r.url());
  });
  await openTopography(page);
  await expect
    .poll(() =>
      page.evaluate(() => window.__topography.metrics.value.complexity),
    )
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    window.__mainStatsReads = 0;
    const read = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      if (this.canvas.width === 96 && this.canvas.height === 96)
        window.__mainStatsReads++;
      return read.apply(this, args);
    };
  });
  const canvas = page.locator("#output-canvas");
  const before = await canvas.evaluate((c) => c.toDataURL());
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.6, {
    steps: 5,
  });
  await page.mouse.up();
  await expect
    .poll(() => canvas.evaluate((c) => c.toDataURL()))
    .not.toBe(before);
  expect(
    await page.evaluate(() => Math.abs(window.__topography.camera.yaw)),
  ).toBeGreaterThan(0.1);
  await page.keyboard.down("Shift");
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.65, {
    steps: 3,
  });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  expect(
    await page.evaluate(() => window.__topography.camera.target[0]),
  ).not.toBe(0);
  const distance = await page.evaluate(
    () => window.__topography.camera.distance,
  );
  await page.mouse.wheel(0, -100);
  await expect
    .poll(() => page.evaluate(() => window.__topography.camera.distance))
    .toBeLessThan(distance);
  await page.locator("#cortical-reset-camera").click();
  expect(
    await page.evaluate(() => [
      window.__topography.camera.yaw,
      window.__topography.camera.pitch,
    ]),
  ).toEqual([0, 0]);
  const images = [];
  for (const mode of ["0", "1", "2", "3"]) {
    await page.getByLabel("WAVE MODE", { exact: true }).selectOption(mode);
    await expect(page.locator("#render-state")).toHaveText("FRAME READY");
    images.push(await canvas.evaluate((c) => c.toDataURL()));
    expect(await page.evaluate(() => window.__topography.gl.getError())).toBe(
      0,
    );
  }
  expect(new Set(images).size).toBe(4);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator("#cortical-tools")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    window.__topographyContext =
      window.__topography.gl.getExtension("WEBGL_lose_context");
    window.__topographyContext.loseContext();
  });
  await expect
    .poll(() => page.evaluate(() => window.__topography.available))
    .toBe(false);
  await page.evaluate(() => window.__topographyContext.restoreContext());
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__topography.graphics)))
    .toBe(true);
  expect(await page.evaluate(() => window.__topography.gl.getError())).toBe(0);
  expect(await page.evaluate(() => window.__topography.estimator.runs)).toBe(0);
  expect(modelRequests).toEqual([]);
  expect(await page.evaluate(() => window.__mainStatsReads)).toBe(0);
  expect(errors).toEqual([]);
});

test("photo depth runs once, rejects replaced photos, and is reused by controls, camera, animation and resizing", async ({
  page,
  context,
}) => {
  await fakeDepth(context);
  await openTopography(page);
  await page
    .locator("#cortical-image")
    .setInputFiles(await photo(page, 64, "first.png"));
  await expect
    .poll(() => page.evaluate(() => window.__topography.estimator.runs))
    .toBe(1);
  expect(await page.evaluate(() => window.__topography.depthMap.kind)).toBe(
    "luminance",
  );
  await page
    .locator("#cortical-image")
    .setInputFiles(await photo(page, 96, "second.png"));
  await expect(page.locator("#cortical-status")).toContainText(
    "Relative depth ready",
  );
  expect(
    await page.evaluate(() => Array.from(window.__topography.depthMap.depth)),
  ).toEqual([0, 1, 0.25, 0.75]);
  expect(await page.evaluate(() => window.__topography.sourceName)).toBe(
    "second.png",
  );
  for (const [label, value] of [
    ["3D EXTRUSION", "0.7"],
    ["CORTICAL GAIN", "0.5"],
  ])
    await page.getByLabel(label, { exact: true }).evaluate((input, value) => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  await page.locator("#cortical-reset-camera").click();
  await page.locator("#toggle-animation").click();
  const initial = await page.locator("#frame-index").textContent();
  await expect
    .poll(() => page.locator("#frame-index").textContent())
    .not.toBe(initial);
  await page.setViewportSize({ width: 1200, height: 800 });
  expect(await page.evaluate(() => window.__topography.estimator.runs)).toBe(2);
  expect(await page.evaluate(() => window.__depthWorkerCount)).toBe(2);
  expect(await page.evaluate(() => window.__depthTerminations)).toBe(2);
  expect(
    await page.evaluate(() => !!window.__topography.estimator.pending),
  ).toBe(false);
  expect(await page.evaluate(() => window.__topography.gl.getError())).toBe(0);
});

test("failed depth keeps the brightness surface interactive and retries only on request", async ({
  page,
  context,
}) => {
  await fakeDepth(context, true);
  await openTopography(page);
  await page
    .locator("#cortical-image")
    .setInputFiles(await photo(page, 96, "offline.png"));
  await expect(page.locator("#cortical-status")).toContainText(
    "Using brightness relief",
  );
  await expect(page.locator("#cortical-retry-depth")).toBeVisible();
  expect(await page.evaluate(() => window.__topography.depthMap.kind)).toBe(
    "luminance",
  );
  await page.getByLabel("WAVE MODE", { exact: true }).selectOption("0");
  expect(await page.evaluate(() => window.__topography.estimator.runs)).toBe(1);
  await page.locator("#cortical-retry-depth").click();
  await expect
    .poll(() => page.evaluate(() => window.__topography.estimator.runs))
    .toBe(2);
  await expect(page.locator("#cortical-status")).toContainText(
    "Using brightness relief",
  );
  expect(await page.evaluate(() => window.__topography.gl.getError())).toBe(0);
});

test("actual GPU wave harmonics meet across the polar branch cut", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const [vertex, shared] = await Promise.all(
      ["cortical-3d.vert", "cortical-waves.glsl"].map((n) =>
        fetch("/assets/js/render/" + n).then((r) => r.text()),
      ),
    );
    const canvas = document.createElement("canvas"),
      gl = canvas.getContext("webgl2");
    const program = gl.createProgram();
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex.replace("#include <cortical-waves>", shared)],
      [
        gl.FRAGMENT_SHADER,
        "#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(1.0);}",
      ],
    ]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.transformFeedbackVaryings(
      program,
      ["v_waveVal"],
      gl.INTERLEAVED_ATTRIBS,
    );
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-0.6, 0, 0, 0.2, 0.500001, -0.6, 0, 0, 0.2, 0.499999]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R16F,
      1,
      1,
      0,
      gl.RED,
      gl.FLOAT,
      new Float32Array([0.5]),
    );
    const identity = new Float32Array([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    for (const n of ["u_mvp", "u_model"])
      gl.uniformMatrix4fv(gl.getUniformLocation(program, n), false, identity);
    gl.uniform2f(gl.getUniformLocation(program, "u_fovea"), 0.5, 0.5);
    gl.uniform2f(gl.getUniformLocation(program, "u_aspect"), 1, 1);
    gl.uniform1f(gl.getUniformLocation(program, "u_frequency"), 13.37);
    gl.uniform1f(gl.getUniformLocation(program, "u_eccentricity"), 0.12);
    const output = gl.createBuffer();
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, output);
    gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, 8, gl.DYNAMIC_READ);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, output);
    const pairs = [];
    gl.enable(gl.RASTERIZER_DISCARD);
    for (let mode = 0; mode < 4; mode++) {
      gl.uniform1i(gl.getUniformLocation(program, "u_wave_mode"), mode);
      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArrays(gl.POINTS, 0, 2);
      gl.endTransformFeedback();
      const data = new Float32Array(2);
      gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, data);
      pairs.push([...data]);
    }
    const error = gl.getError();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { pairs, error };
  });
  for (const [a, b] of result.pairs) {
    expect(Number.isFinite(a) && Number.isFinite(b)).toBe(true);
    expect(Math.abs(a - b)).toBeLessThan(0.001);
  }
  expect(result.error).toBe(0);
});
