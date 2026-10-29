import { createDomeMesh } from "./dome-mesh.js";

export async function createDomeGraphics(gl, isCurrent) {
  const urls = [
    "../shaders/cortical-dome.vert",
    "../shaders/cortical-dome.frag",
    "./cortical-waves.glsl",
    "../shaders/cortical-dome-mapping.glsl",
  ];
  const sources = await Promise.all(
    urls.map(async (url) => {
      const response = await fetch(new URL(url, import.meta.url));
      if (!response.ok) throw new Error(`Could not load ${url}.`);
      return response.text();
    }),
  );
  if (!isCurrent())
    throw new DOMException("Dome graphics cancelled.", "AbortError");
  const program = gl.createProgram(),
    shaders = [];
  let vao, vertices, indices;
  const textures = [];
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, sources[0]],
      [gl.FRAGMENT_SHADER, sources[1]],
    ]) {
      const shader = gl.createShader(type);
      shaders.push(shader);
      gl.shaderSource(
        shader,
        source
          .replace("#include <cortical-waves>", sources[2])
          .replace("#include <dome-mapping>", sources[3]),
      );
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program));
    const mesh = createDomeMesh();
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    vertices = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
    indices = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    for (let i = 0; i < 3; i++) {
      const texture = gl.createTexture();
      textures.push(texture);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    const uniforms = Object.fromEntries(
      [
        "view",
        "proj",
        "dream_360",
        "mirrored_wrap",
        "color_retention",
        "depth",
        "neural",
        "viewDir",
        "time",
        "wave_mode",
        "frequency",
        "speed",
        "gain",
        "depth_extrude",
        "neural_extrude",
        "eccentricity",
        "edge_coupling",
        "dispersion",
        "shininess",
        "fog_density",
        "fovea",
        "aspect",
      ].map((name) => [name, gl.getUniformLocation(program, `u_${name}`)]),
    );
    return {
      program,
      vao,
      vertices,
      indices,
      textures,
      uniforms,
      count: mesh.indices.length,
    };
  } catch (error) {
    disposeDomeGraphics(gl, { program, vao, vertices, indices, textures });
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}

export function disposeDomeGraphics(gl, g) {
  gl.deleteBuffer(g.vertices);
  gl.deleteBuffer(g.indices);
  gl.deleteVertexArray(g.vao);
  for (const texture of g.textures) gl.deleteTexture(texture);
  gl.deleteProgram(g.program);
}
