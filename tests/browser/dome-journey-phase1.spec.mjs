import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

async function blank(page) {
  await page.route("http://127.0.0.1:8080/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Depth-carved Dream Drift</title>",
    }),
  );
  await page.goto("/");
}

test("actual shader intersections follow depth, resolve foreground occlusion, and feedback uses 16px history blocks", async ({
  page,
}) => {
  test.setTimeout(120000);
  await blank(page);
  const result = await page.evaluate(async () => {
    const { CorticalDreamDomeModel } =
      await import("/assets/js/models/cortical-dream-dome.js");
    const model = new CorticalDreamDomeModel();
    const target = document.createElement("canvas");
    target.width = 64;
    target.height = 32;
    const p = Object.fromEntries(model.controls.map((c) => [c.key, c.default]));
    Object.assign(p, {
      gain: 0,
      depthScale: 0.6,
      neuralSwell: 0,
      cameraDolly: 0,
    });
    await model.render(target, p, 0);
    const gl = model.gl,
      g = model.graphics;
    const paths = [
      "/assets/js/render/cortical-waves.glsl",
      "/assets/js/shaders/cortical-dome-mapping.glsl",
      "/assets/js/shaders/dome-journey-mapping.glsl",
      "/assets/js/shaders/dome-journey-depth.glsl",
      "/assets/js/shaders/dome-journey-geometry.glsl",
      "/assets/js/shaders/dome-journey-feedback.glsl",
    ];
    const includes = await Promise.all(
      paths.map(async (path) => (await fetch(path)).text()),
    );
    const fragment = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D u_neural, u_journey_anchor, u_journey_echo, u_journey_dream, u_journey_structure, u_journey_cavern;
uniform float u_depth_extrude, u_neural_extrude, u_edge_coupling, u_dispersion;
${includes.join("\n")}
uniform int u_probe; uniform vec3 u_origin; uniform vec3 u_ray;
out vec4 out_color;
void main() {
  if (u_probe == 1) { out_color = vec4(journeyFeedback(vec3(0.0), vec3(0.0,0.0,-1.0)), 1.0); return; }
  if (u_probe == 2) { float a = journeyAperture(u_ray); out_color = vec4(a,a,a,1.0); return; }
  if (u_probe == 3) { vec4 c = dreamCortical(vec2(0.0)); out_color = vec4(any(isnan(c)) || any(isinf(c)) ? 1.0 : 0.0, 0.0, 0.0, 1.0); return; }
  float distance; vec4 surface; bool hit = dreamTrace(u_origin, u_ray, distance, surface);
  float encoded = floor(clamp(distance / 32.0,0.0,1.0) * 65535.0 + 0.5);
  out_color = vec4(floor(encoded / 256.0) / 255.0, mod(encoded,256.0) / 255.0, 0.0, hit ? 1.0 : 0.0);
}`;
    const program = gl.createProgram(),
      shaders = [];
    for (const [type, source] of [
      [
        gl.VERTEX_SHADER,
        `#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0.0,1.0);}`,
      ],
      [gl.FRAGMENT_SHADER, fragment],
    ]) {
      const shader = gl.createShader(type);
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    // Reuse actual production uniforms/textures, including source depth orientation.
    for (
      let i = 0;
      i < gl.getProgramParameter(g.program, gl.ACTIVE_UNIFORMS);
      i++
    ) {
      const info = gl.getActiveUniform(g.program, i),
        location = gl.getUniformLocation(program, info.name);
      if (location === null) continue;
      const value = gl.getUniform(
        g.program,
        gl.getUniformLocation(g.program, info.name),
      );
      if ([gl.INT, gl.SAMPLER_2D].includes(info.type))
        gl.uniform1i(location, value);
      else if (info.type === gl.UNSIGNED_INT) gl.uniform1ui(location, value);
      else if (info.type === gl.FLOAT) gl.uniform1f(location, value);
      else if (info.type === gl.FLOAT_VEC2) gl.uniform2fv(location, value);
      else if (info.type === gl.FLOAT_VEC3) gl.uniform3fv(location, value);
      else if (info.type === gl.FLOAT_VEC4) gl.uniform4fv(location, value);
    }
    const uniform = (name) => gl.getUniformLocation(program, name);
    gl.uniform1i(uniform("u_journey_enabled"), 1);
    gl.uniform1f(uniform("u_journey_source_weight"), 1);
    gl.uniform4f(uniform("u_journey_weights"), 0, 0, 0, 0);
    gl.uniform1ui(uniform("u_journey_seed"), 0);
    gl.uniform1f(uniform("u_journey_distance"), 9);
    gl.uniform1f(uniform("u_journey_geometry"), 1);
    gl.uniform4f(uniform("u_journey_style"), 0.7, 0.8, 0.7, 0);
    gl.uniform3f(uniform("u_origin"), 0, 0, 0);
    gl.uniform3f(uniform("u_ray"), 0, 1, 0);
    const fb = gl.createFramebuffer(),
      image = gl.createTexture(),
      vao = gl.createVertexArray();
    gl.activeTexture(gl.TEXTURE13);
    gl.bindTexture(gl.TEXTURE_2D, image);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      64,
      32,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      image,
      0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error("Probe framebuffer incomplete");
    gl.bindVertexArray(vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.viewport(0, 0, 64, 32);
    const pixels = new Uint8Array(64 * 32 * 4);
    const draw = (probe) => {
      gl.uniform1i(uniform("u_probe"), probe);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, 64, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels.slice();
    };
    const depth = (values, width = 64) => {
      model.depthMap = { width, height: 1, depth: Float32Array.from(values) };
      model.uploadGeometry();
    };
    const trace = (origin = [0, 0, 0], ray = [0, 1, 0]) => {
      gl.uniform3fv(uniform("u_origin"), origin);
      gl.uniform3fv(uniform("u_ray"), ray);
      const rgba = draw(0);
      return {
        distance: ((rgba[0] * 256 + rgba[1]) / 65535) * 32,
        hit: rgba[3] === 255,
      };
    };
    try {
      depth(Array(64).fill(0.9));
      const foreground = trace();
      depth(Array(64).fill(0.1));
      const background = trace();
      const parallax = trace([1, 0, 0]);
      const cap = draw(3)[0];
      // A narrow foreground strip must intersect before the distant backdrop.
      const values = Array.from({ length: 512 }, (_, x) =>
        x >= 249 && x <= 251 ? 0.9 : 0.1,
      );
      depth(values, 512);
      const occlusion = trace([1.2, 0, 0], [0, 0, -1]);
      // Independent fine-step oracle (0.0005 world units), not the shader's stepping scheme.
      const field = (t) => {
        const phase = 0,
          px = 1.2,
          pz = -t;
        const wx = px + 1.8 * Math.sin(pz * 0.14 + phase),
          wz = pz + 1.8 * Math.sin(px * 0.13 - phase);
        const bx = Math.floor(wx / 18),
          bz = Math.floor(wz / 18);
        let result = -Infinity;
        for (let z = 0; z < 2; z++)
          for (let x = 0; x < 2; x++) {
            const cx = bx + x,
              cz = bz + z,
              qx = wx - cx * 18,
              qz = wz - cz * 18;
            let su = Math.atan2(qx, -qz) / (2 * Math.PI) + 0.5;
            su = Math.abs((((((su - 0.25) * 2 - 1) % 2) + 2) % 2) - 1);
            const sample = su * 512 - 0.5,
              index = Math.floor(sample),
              f = sample - index;
            const at = (i) => values[Math.max(0, Math.min(511, i))];
            const d = at(index) * (1 - f) + at(index + 1) * f;
            // Only the origin cell can be reached by this short ray; side limits
            // are outside its tested foreground silhouette.
            const v = 4 + (1 - d) * 5.8 - Math.hypot(qx, qz);
            result = Math.max(result, v);
          }
        return result;
      };
      let reference = null;
      const sign = Math.sign(field(0));
      for (let t = 0.0005; t < 16; t += 0.0005)
        if (Math.sign(field(t)) !== sign) {
          reference = t;
          break;
        }
      gl.uniform3f(uniform("u_ray"), 0, 0, -1);
      gl.uniform1f(uniform("u_journey_distance"), 2.5);
      const frontAperture = draw(2)[0];
      gl.uniform3f(uniform("u_ray"), 0, 0, 1);
      const rearAperture = draw(2)[0];
      gl.uniform1f(uniform("u_journey_distance"), 4.001);
      const immersedRear = draw(2)[0];
      // Actual previous-frame texture: static white history makes block retention
      // measurable, and invalid/black history must remove it.
      gl.activeTexture(gl.TEXTURE12);
      gl.bindTexture(gl.TEXTURE_2D, g.textures[12]);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGB8,
        64,
        32,
        0,
        gl.RGB,
        gl.UNSIGNED_BYTE,
        new Uint8Array(64 * 32 * 3).fill(255),
      );
      gl.uniform2f(uniform("u_journey_resolution"), 64, 32);
      gl.uniform2f(uniform("u_journey_motion"), 0, 0);
      gl.uniform1f(uniform("u_journey_history_valid"), 1);
      const history = draw(1);
      let withinBlock = 0;
      const blockValues = [];
      for (let by = 0; by < 2; by++)
        for (let bx = 0; bx < 4; bx++) {
          const value = history[(by * 16 * 64 + bx * 16) * 4];
          blockValues.push(value);
          for (let y = by * 16; y < by * 16 + 16; y++)
            for (let x = bx * 16; x < bx * 16 + 16; x++)
              withinBlock = Math.max(
                withinBlock,
                Math.abs(history[(y * 64 + x) * 4] - value),
              );
        }
      gl.uniform1f(uniform("u_journey_history_valid"), 0);
      const invalidHistory = Math.max(...draw(1).filter((_, i) => i % 4 !== 3));
      gl.uniform1f(uniform("u_journey_history_valid"), 1);
      gl.uniform4f(uniform("u_journey_style"), 0.7, 0.8, 0.7, 1);
      const clearHistory = Math.max(...draw(1).filter((_, i) => i % 4 !== 3));
      return {
        foreground,
        background,
        parallax,
        cap,
        occlusion,
        reference,
        frontAperture,
        rearAperture,
        immersedRear,
        withinBlock,
        blockValues,
        invalidHistory,
        clearHistory,
        gl: gl.getError(),
      };
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      gl.deleteTexture(image);
      gl.deleteVertexArray(vao);
      for (const shader of shaders) gl.deleteShader(shader);
      gl.deleteProgram(program);
      model.dispose();
    }
  });
  console.log(JSON.stringify(result));
  expect(result.foreground.hit).toBe(true);
  expect(result.background.hit).toBe(true);
  expect(result.foreground.distance).toBeCloseTo(4.58, 2);
  expect(result.background.distance).toBeCloseTo(9.22, 2);
  expect(result.parallax.distance).toBeLessThan(
    result.background.distance - 0.04,
  );
  expect(result.occlusion.hit).toBe(true);
  expect(result.reference).not.toBeNull();
  expect(Math.abs(result.occlusion.distance - result.reference)).toBeLessThan(
    0.025,
  );
  expect(result.cap).toBe(0);
  expect(result.frontAperture).toBe(255);
  expect(result.rearAperture).toBe(0);
  expect(result.immersedRear).toBe(255);
  expect(result.withinBlock).toBe(0);
  expect(new Set(result.blockValues).size).toBeGreaterThan(2);
  expect(result.invalidHistory).toBe(0);
  expect(result.clearHistory).toBe(0);
  expect(result.gl).toBe(0);
});

test("staged entry is continuous at 1.5 and 4 units and retreat restores every prior view", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  await blank(page);
  const result = await page.evaluate(async () => {
    const { CorticalDreamDomeModel } =
      await import("/assets/js/models/cortical-dream-dome.js");
    const model = new CorticalDreamDomeModel();
    const view = document.createElement("canvas");
    view.width = 320;
    view.height = 240;
    const p = Object.fromEntries(model.controls.map((c) => [c.key, c.default]));
    Object.assign(p, {
      gain: 0,
      neuralSwell: 0,
      cameraDolly: 0,
      edgeCoupling: 0,
      chromaticDispersion: 0,
    });
    const render = async () => {
      await model.render(view, p, 0);
      return view.getContext("2d").getImageData(0, 0, 320, 240).data;
    };
    const diff = (a, b) => {
      let sum = 0,
        max = 0;
      for (let i = 0; i < a.length; i++)
        if (i % 4 !== 3) {
          const d = Math.abs(a[i] - b[i]);
          sum += d;
          max = Math.max(max, d);
        }
      return { mean: sum / (320 * 240 * 3), max };
    };
    try {
      const waking = await render();
      model.journey.enabled = true;
      model.journey.newDream(42);
      model.journey.corruption = 0;
      const distances = [0, 0.75, 1.499, 1.5, 1.501, 2.5, 3.999, 4, 4.001, 6],
        frames = [],
        images = [];
      for (const d of distances) {
        model.journey.position = [0, -d];
        const pixels = await render();
        frames.push(pixels);
        if ([0, 0.75, 1.5, 2.5, 4, 6].includes(d))
          images.push({
            name: `entrance-${d}`,
            png: view.toDataURL().split(",")[1],
          });
      }
      const reversed = [];
      for (let i = distances.length - 1; i >= 0; i--) {
        model.journey.position = [0, -distances[i]];
        reversed.push(diff(frames[i], await render()));
      }
      model.journey.home();
      model.camera.reset();
      const restored = diff(waking, await render());
      const near = distances
        .map((d, i) => (i ? { d, ...diff(frames[i - 1], frames[i]) } : null))
        .filter(Boolean);
      return {
        images,
        near,
        reversed,
        home: diff(waking, frames[0]),
        restored,
        gl: model.gl.getError(),
      };
    } finally {
      model.dispose();
    }
  });
  for (const image of result.images)
    await writeFile(
      info.outputPath(`${image.name}.png`),
      Buffer.from(image.png, "base64"),
    );
  delete result.images;
  console.log(JSON.stringify(result));
  expect(result.home.max).toBe(0);
  expect(result.restored.max).toBe(0);
  for (const frame of result.reversed) expect(frame.max).toBe(0);
  for (const d of [1.5, 1.501, 4, 4.001])
    expect(result.near.find((r) => r.d === d).mean).toBeLessThan(0.5);
  expect(result.near.find((r) => r.d === 2.5).mean).toBeGreaterThan(0.5);
  expect(result.gl).toBe(0);
});
