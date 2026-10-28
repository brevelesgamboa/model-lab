import { test, expect } from "@playwright/test";

async function openDome(page) {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
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
  await page.waitForFunction(() => Boolean(window.__dome?.graphics));
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
}

async function photo(page, width = 96) {
  const data = await page.evaluate((width) => {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = 48;
    const ctx = c.getContext("2d"),
      g = ctx.createLinearGradient(0, 0, width, 48);
    g.addColorStop(0, "#19478a");
    g.addColorStop(1, "#ed9c51");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, 48);
    ctx.fillStyle = "#a52e66";
    ctx.fillRect(width / 4, 10, width / 3, 25);
    return c.toDataURL().split(",")[1];
  }, width);
  return {
    name: `photo-${width}.png`,
    mimeType: "image/png",
    buffer: Buffer.from(data, "base64"),
  };
}

async function fakeMaps(context, options = {}) {
  await context.route("**/depth-estimator.worker.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `self.onmessage=({data:{bitmap}})=>{
      const width=bitmap.width;bitmap.close();
      setTimeout(()=>{const depth=new Float32Array([0,1,.25,.75]);
      self.postMessage({type:'result',width:2,height:2,depth,backend:'fixture',inferenceMs:3},[depth.buffer]);},width===64?1000:100);
    };`,
    }),
  );
  await context.route("**/inception-feature-map.worker.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `self.onmessage=({data:{bitmap,layer,channel}})=>{
      bitmap.close();
      setTimeout(()=>{
        if(${Boolean(options.featureFails)}){self.postMessage({type:'error',error:'Offline fixture'});return;}
        const values=new Float32Array(layer==='Conv2d_4a_3x3'?[0,.2,.6,1]:[1,.6,.2,0]);
        self.postMessage({type:'result',width:2,height:2,values,backend:'fixture',inferenceMs:3,retainedTensors:0},[values.buffer]);
      },layer==='mixed_5b'?600:100);
    };`,
    }),
  );
  return options;
}

async function ready(page) {
  await expect
    .poll(() =>
      page.evaluate(() => [
        window.__dome.depthState,
        window.__dome.featureState,
      ]),
    )
    .toEqual(["ready", "ready"]);
}

test("the independent dome closes a 360 view, renders all waves, supports drag/keyboard and restores graphics without inference", async ({
  page,
}) => {
  const errors = [],
    downloads = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (
      r.url().includes("huggingface.co") ||
      r.url().includes("models/inception/model.json")
    )
      downloads.push(r.url());
  });
  await openDome(page);
  expect(
    await page
      .locator('#model-select option[value="cortical-topography"]')
      .count(),
  ).toBe(1);
  const canvas = page.locator("#output-canvas");
  const first = await canvas.evaluate((c) => c.toDataURL());
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.6, {
    steps: 5,
  });
  await page.mouse.up();
  await expect
    .poll(() => canvas.evaluate((c) => c.toDataURL()))
    .not.toBe(first);
  await canvas.focus();
  const yaw = await page.evaluate(() => window.__dome.camera.yaw);
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => page.evaluate(() => window.__dome.camera.yaw))
    .not.toBe(yaw);
  await page.locator("#dome-reset-view").click();
  expect(
    await page.evaluate(() => [
      window.__dome.camera.yaw,
      window.__dome.camera.pitch,
    ]),
  ).toEqual([0, 0]);
  const images = [];
  for (const mode of ["0", "1", "2", "3"]) {
    await page
      .getByLabel("CORTICAL WAVE MODE", { exact: true })
      .selectOption(mode);
    await expect(page.locator("#render-state")).toHaveText("FRAME READY");
    images.push(await canvas.evaluate((c) => c.toDataURL()));
  }
  expect(new Set(images).size).toBe(4);
  await page.evaluate(() => {
    window.__dome.camera.look(-Math.PI / 0.006, 0);
    window.__dome.onStateChange();
  });
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
  // The rear is covered, not the empty clear color.
  expect(
    await canvas.evaluate((c) => {
      const data = c
        .getContext("2d")
        .getImageData(c.width / 2, c.height / 2, 1, 1).data;
      return data[0] + data[1] + data[2];
    }),
  ).toBeGreaterThan(40);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const camera = await page.evaluate(() => ({
    yaw: window.__dome.camera.yaw,
    pitch: window.__dome.camera.pitch,
  }));
  await page.evaluate(() => {
    window.__domeLost = window.__dome.gl.getExtension("WEBGL_lose_context");
    window.__domeLost.loseContext();
  });
  await expect
    .poll(() => page.evaluate(() => window.__dome.available))
    .toBe(false);
  await page.evaluate(() => window.__domeLost.restoreContext());
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__dome.graphics)))
    .toBe(true);
  expect(
    await page.evaluate(() => ({
      yaw: window.__dome.camera.yaw,
      pitch: window.__dome.camera.pitch,
    })),
  ).toEqual(camera);
  expect(
    await page.evaluate(() => [
      window.__dome.estimator.runs,
      window.__dome.featureEstimator.runs,
      window.__dome.gl.getError(),
    ]),
  ).toEqual([0, 0, 0]);
  expect(downloads).toEqual([]);
  expect(errors).toEqual([]);
});

test("photo/target replacements reject stale maps; controls, navigation, camera and resize reuse completed maps", async ({
  page,
  context,
}) => {
  await fakeMaps(context);
  await openDome(page);
  await page.locator("#dome-image").setInputFiles(await photo(page, 64));
  await expect
    .poll(() => page.evaluate(() => window.__dome.estimator.runs))
    .toBe(1);
  await page.locator("#dome-image").setInputFiles(await photo(page, 96));
  await ready(page);
  expect(await page.evaluate(() => window.__dome.sourceName)).toBe(
    "photo-96.png",
  );
  const depthRuns = await page.evaluate(() => window.__dome.estimator.runs);
  const target = page.getByLabel("NEURAL FEATURE TARGET", { exact: true });
  await target.selectOption("1");
  await expect
    .poll(() => page.evaluate(() => window.__dome.featureState))
    .toBe("loading");
  await target.selectOption("2");
  await ready(page);
  expect(await page.evaluate(() => window.__dome.featureMap.layer)).toBe(
    "Conv2d_4a_3x3",
  );
  expect(
    await page.evaluate(() => Array.from(window.__dome.featureMap.values)),
  ).toEqual([0, expect.closeTo(0.2), expect.closeTo(0.6), 1]);
  expect(await page.evaluate(() => window.__dome.estimator.runs)).toBe(
    depthRuns,
  );
  const counts = await page.evaluate(() => [
    window.__dome.estimator.runs,
    window.__dome.featureEstimator.runs,
  ]);
  await page.getByLabel("NEURAL SWELL", { exact: true }).evaluate((input) => {
    input.value = ".9";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#toggle-animation").click();
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.locator("#output-canvas").focus();
  await page.keyboard.press("ArrowLeft");
  await page.locator("#model-select").selectOption("cortical-topography");
  await expect(page.locator("#cortical-tools")).toBeVisible();
  await page.locator("#model-select").selectOption("cortical-dream-dome");
  await expect(page.locator("#dome-status")).toContainText(
    "Conv2d_4a_3x3:42 ready",
  );
  expect(
    await page.evaluate(() => [
      window.__dome.estimator.runs,
      window.__dome.featureEstimator.runs,
    ]),
  ).toEqual(counts);
  expect(
    await page.evaluate(() => [
      Boolean(window.__dome.estimator.pending),
      Boolean(window.__dome.featureEstimator.pending),
      window.__dome.gl.getError(),
    ]),
  ).toEqual([false, false, 0]);
  // Reset is a parameter-set operation, rather than a select input event.
  await page.locator("#reset-parameters").click();
  await ready(page);
  expect(await page.evaluate(() => window.__dome.featureMap.layer)).toBe(
    "mixed_5b",
  );
  expect(await page.evaluate(() => window.__dome.estimator.runs)).toBe(
    depthRuns,
  );
  await target.selectOption("1");
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(window.__dome.featureEstimator.pending)),
    )
    .toBe(true);
  await page.locator("#model-select").selectOption("cortical-topography");
  expect(
    await page.evaluate(() => window.__dome.featureEstimator.pending),
  ).toBe(null);
});

test("a missing feature model keeps depth and waves interactive and only retries on request", async ({
  page,
  context,
}) => {
  const fixture = await fakeMaps(context, { featureFails: true });
  await openDome(page);
  await page.locator("#dome-image").setInputFiles(await photo(page));
  await expect
    .poll(() => page.evaluate(() => window.__dome.featureState))
    .toBe("fallback");
  expect(await page.evaluate(() => window.__dome.depthState)).toBe("ready");
  expect(
    await page.evaluate(() => Array.from(window.__dome.featureMap.values)),
  ).toEqual([0]);
  await page
    .getByLabel("CORTICAL WAVE MODE", { exact: true })
    .selectOption("0");
  await expect(page.locator("#render-state")).toHaveText("FRAME READY");
  expect(await page.evaluate(() => window.__dome.featureEstimator.runs)).toBe(
    1,
  );
  fixture.featureFails = false;
  await page.locator("#dome-retry").click();
  await ready(page);
  expect(
    await page.evaluate(() => [
      window.__dome.estimator.runs,
      window.__dome.featureEstimator.runs,
    ]),
  ).toEqual([1, 2]);
});

test("real spatial feature maps use one forward pass, normalize on GPU and release tensors for all three targets", async ({
  page,
  context,
}) => {
  test.setTimeout(150000);
  await context.route("**/inception-feature-map.worker.js", async (route) => {
    const response = await route.fetch();
    const guard = `const originalImport=self.importScripts.bind(self);
      self.importScripts=(...urls)=>{originalImport(...urls);
        self.tf.engine().gradients=()=>{throw new Error('Unexpected backward pass')};
        const load=self.tf.loadGraphModel;self.tf.loadGraphModel=async(...args)=>{
          const model=await load(...args),execute=model.execute.bind(model);let count=0;
          model.execute=(...args)=>{if(++count>1)throw new Error('Repeated forward pass');return execute(...args)};
          return model;
        };
      };\n`;
    await route.fulfill({ response, body: guard + (await response.text()) });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto("/");
  const results = await page.evaluate(async () => {
    const { FeatureHeatmapEstimator } =
      await import("/assets/js/models/inception-feature-map.js");
    const c = document.createElement("canvas");
    c.width = c.height = 299;
    const ctx = c.getContext("2d"),
      gradient = ctx.createLinearGradient(0, 0, 299, 299);
    gradient.addColorStop(0, "#1540a2");
    gradient.addColorStop(1, "#ed9838");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 299, 299);
    ctx.fillStyle = "#3a902b";
    for (let i = 0; i < 8; i++) {
      ctx.beginPath();
      ctx.arc(i * 40, 140, 30, 0, Math.PI * 2);
      ctx.fill();
    }
    const estimator = new FeatureHeatmapEstimator(),
      results = [];
    for (const [layer, channel] of [
      ["mixed_5b", 120],
      ["mixed_6a", 42],
      ["Conv2d_4a_3x3", 42],
    ]) {
      const map = await estimator.estimate(c, layer, channel);
      results.push({
        layer,
        shape: [map.height, map.width],
        min: Math.min(...map.values),
        max: Math.max(...map.values),
        retained: map.retainedTensors,
      });
    }
    return {
      results,
      runs: estimator.runs,
      pending: !!estimator.pending,
      mainTf: !!window.tf,
    };
  });
  expect(results.runs).toBe(3);
  expect(results.pending).toBe(false);
  expect(results.mainTf).toBe(false);
  expect(results.results.map((r) => r.shape)).toEqual([
    [35, 35],
    [17, 17],
    // This optimized graph's named 4a Relu follows MaxPool_5a.
    [35, 35],
  ]);
  for (const r of results.results) {
    expect(r.min).toBeCloseTo(0);
    expect(r.max === 0 || Math.abs(r.max - 1) < 1e-5).toBe(true);
    expect(r.retained).toBe(0);
  }
});

test("actual dome vertex displacement closes rear/pole seams and aligns depth and neural maps with the photo", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const sources = await Promise.all(
      [
        "/assets/js/shaders/cortical-dome.vert",
        "/assets/js/shaders/cortical-dome-mapping.glsl",
        "/assets/js/render/cortical-waves.glsl",
      ].map(async (url) => (await fetch(url)).text()),
    );
    const gl = document.createElement("canvas").getContext("webgl2");
    const program = gl.createProgram();
    for (const [type, source] of [
      [
        gl.VERTEX_SHADER,
        sources[0]
          .replace("#include <dome-mapping>", sources[1])
          .replace("#include <cortical-waves>", sources[2]),
      ],
      [
        gl.FRAGMENT_SHADER,
        "#version 300 es\nprecision highp float;out vec4 c;void main(){c=vec4(1);}",
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
      ["v_worldPos", "v_waveVal"],
      gl.INTERLEAVED_ATTRIBS,
    );
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const coords = [
      [0, 0.4],
      [1, 0.4],
      [0.1, 1],
      [0.9, 1],
      [0.1, 0],
      [0.9, 0],
      [0.5 - 70 / 360, 0.5],
      [0.5 + 70 / 360, 0.5],
      [0.5, 0.25],
      [0.5, 0.75],
    ];
    const data = new Float32Array(
      coords.flatMap(([u, v]) => {
        const lon = (u - 0.5) * Math.PI * 2,
          lat = (v - 0.5) * Math.PI;
        const ring = v === 0 || v === 1 ? 0 : Math.cos(lat);
        return [
          Math.sin(lon) * ring,
          Math.sin(lat),
          -Math.cos(lon) * ring,
          u,
          v,
        ];
      }),
    );
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    for (const [i, values] of [
      [0, [0, 1, 0, 1]],
      [1, [1, 1, 0, 0]],
    ]) {
      gl.activeTexture(gl.TEXTURE0 + i);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
        gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
        gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R16F,
        2,
        2,
        0,
        gl.RED,
        gl.FLOAT,
        new Float32Array(values),
      );
    }
    const loc = (name) => gl.getUniformLocation(program, `u_${name}`);
    const identity = new Float32Array([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    for (const n of ["view", "proj"])
      gl.uniformMatrix4fv(loc(n), false, identity);
    gl.uniform1i(loc("depth"), 0);
    gl.uniform1i(loc("neural"), 1);
    gl.uniform2f(loc("fovea"), 0.5, 0.5);
    gl.uniform2f(loc("aspect"), 1, 1);
    gl.uniform1f(loc("frequency"), 13.37);
    gl.uniform1f(loc("eccentricity"), 0.12);
    const output = gl.createBuffer();
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, output);
    gl.bufferData(
      gl.TRANSFORM_FEEDBACK_BUFFER,
      coords.length * 16,
      gl.DYNAMIC_READ,
    );
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, output);
    gl.enable(gl.RASTERIZER_DISCARD);
    function draw(depth, neural, gain, mode = 0) {
      gl.uniform1f(loc("depth_extrude"), depth);
      gl.uniform1f(loc("neural_extrude"), neural);
      gl.uniform1f(loc("gain"), gain);
      gl.uniform1i(loc("wave_mode"), mode);
      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArrays(gl.POINTS, 0, coords.length);
      gl.endTransformFeedback();
      const values = new Float32Array(coords.length * 4);
      gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, values);
      return coords.map((_, i) => [...values.slice(i * 4, i * 4 + 4)]);
    }
    const depth = draw(1.5, 0, 0),
      neural = draw(0, 1, 0);
    const modes = [0, 1, 2, 3].map((mode) => draw(1.5, 1, 1, mode));
    const error = gl.getError();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { depth, neural, modes, error };
  });
  const radius = (row) => Math.hypot(...row.slice(0, 3));
  expect(radius(result.depth[6])).toBeCloseTo(5);
  expect(radius(result.depth[7])).toBeCloseTo(3.5);
  expect(radius(result.neural[8])).toBeCloseTo(5);
  expect(radius(result.neural[9])).toBeCloseTo(4);
  for (const rows of result.modes)
    for (const [a, b] of [
      [0, 1],
      [2, 3],
      [4, 5],
    ])
      for (let i = 0; i < 4; i++) expect(rows[a][i]).toBeCloseTo(rows[b][i], 4);
  expect(result.error).toBe(0);
});
