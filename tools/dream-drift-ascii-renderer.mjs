// Isolated WebGL2 display experiment. No application controls or shaders change.
import { createDomeMesh, DomeCamera } from "../assets/js/render/dome-mesh.js";

export function createArchMesh({ z = -3, radius = 1.7, tube = 0.045 } = {}) {
  // Sweep a real tube around two uprights and a semicircular roof.
  const path = [
    [-radius, -1.35],
    [-radius, 0.12],
  ];
  for (let i = 1; i <= 40; i++) {
    const a = Math.PI - (i / 40) * Math.PI;
    path.push([Math.cos(a) * radius, 0.12 + Math.sin(a) * radius]);
  }
  path.push([radius, -1.35]);
  const vertices = [],
    indices = [],
    sides = 8;
  for (let i = 0; i < path.length; i++) {
    const before = path[Math.max(0, i - 1)],
      after = path[Math.min(path.length - 1, i + 1)];
    const dx = after[0] - before[0],
      dy = after[1] - before[1];
    const length = Math.hypot(dx, dy);
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * Math.PI * 2,
        s = Math.sin(a),
        c = Math.cos(a);
      vertices.push(
        path[i][0] - (dy / length) * c * tube,
        path[i][1] + (dx / length) * c * tube,
        z + s * tube,
        c,
        s,
      );
      if (i < path.length - 1) {
        const p = i * sides + j,
          q = i * sides + ((j + 1) % sides);
        indices.push(p, q, p + sides, q, q + sides, p + sides);
      }
    }
  }
  return {
    vertices: new Float32Array(vertices),
    indices: new Uint16Array(indices),
  };
}

const vertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 position;
layout(location=1) in vec2 uv;
uniform mat4 view, projection;
uniform sampler2D heightMap;
uniform float relief, surface;
out vec2 vUV;
out vec3 world;
void main(){
  vUV=uv;
  float h=textureLod(heightMap,uv,0.).r;
  world=surface<.5 ? position*(5.-h*relief) : position;
  gl_Position=projection*view*vec4(world,1.);
}`;

const fragment = `#version 300 es
precision highp float;
uniform sampler2D colorMap, naturalMap, seedMap, glyphMap;
uniform vec4 head;
uniform vec2 feather;
uniform float mode, strength, surface;
in vec2 vUV;
in vec3 world;
out vec4 color;
float keepHead(vec2 p){
  vec2 d=max(head.xy-p,p-head.xy-head.zw);
  return 1.-smoothstep(0.,1.,max(d.x/feather.x,d.y/feather.y));
}
float luma(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
void main(){
  if(surface>1.5){
    // Depth-tested architectural floor. Derivatives keep its grid antialiased.
    vec2 p=world.xz*2.;
    vec2 d=abs(fract(p-.5)-.5)/max(fwidth(p),vec2(.0001));
    float line=1.-min(min(d.x,d.y),1.);
    color=vec4(mix(vec3(.012,.018,.055),vec3(.03,.35,.45),line*.6),.62);
    return;
  }
  if(surface>.5){
    vec3 c=mix(vec3(.04,.95,1.),vec3(.7,.08,1.),smoothstep(-1.7,1.7,world.x));
    color=vec4(c*(.55+.45*abs(vUV.x)),1.);
    return;
  }
  vec3 base=texture(colorMap,vUV).rgb;
  if(mode<.5){color=vec4(base,1.);return;}
  // Integer UV cells stay attached to the mesh, including during camera turns.
  vec2 grid=vec2(192.,64.);
  vec2 cell=floor(vUV*grid), center=(cell+.5)/grid;
  vec3 sampleColor=textureLod(colorMap,center,0.).rgb;
  float light=luma(sampleColor);
  float glyph=floor(clamp(light,0.,.999)*14.);
  vec2 local=fract(vUV*grid);
  float ink=texture(glyphMap,vec2((glyph+local.x)/14.,local.y)).r;
  vec3 hue=sampleColor/max(max(sampleColor.r,sampleColor.g),max(sampleColor.b,.001));
  vec3 ascii=mix(sampleColor*.11,hue*(.55+.45*light),ink);
  vec3 delta=textureLod(naturalMap,center,0.).rgb-textureLod(seedMap,center,0.).rgb;
  float change=smoothstep(.015,.16,length(delta));
  float amount=mode>1.5 ? 1. : strength*(.3+.7*change)*(1.-keepHead(vec2(vUV.x,1.-vUV.y)));
  color=vec4(mix(base,ascii,amount),1.);
}`;

function makeProgram(gl) {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program));
  return program;
}

export function createAsciiRenderer(canvas) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error("This experiment requires WebGL2.");
  const program = makeProgram(gl),
    camera = new DomeCamera();
  const names = [
    "view",
    "projection",
    "heightMap",
    "colorMap",
    "naturalMap",
    "seedMap",
    "glyphMap",
    "relief",
    "surface",
    "mode",
    "strength",
    "head",
    "feather",
  ];
  const u = Object.fromEntries(
    names.map((n) => [n, gl.getUniformLocation(program, n)]),
  );
  const meshes = [];
  const mesh = ({ vertices, indices }) => {
    const vao = gl.createVertexArray(),
      vb = gl.createBuffer(),
      ib = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    const result = { vao, vb, ib, count: indices.length };
    meshes.push(result);
    return result;
  };
  const sphere = mesh(createDomeMesh(192));
  const arches = [
    mesh(createArchMesh()),
    mesh(createArchMesh({ z: -4.05, radius: 1.45, tube: 0.035 })),
  ];
  const floor = mesh({
    vertices: new Float32Array([
      -4, -1.35, -0.7, 0, 0, 4, -1.35, -0.7, 1, 0, -4, -1.35, -4.5, 0, 1, 4,
      -1.35, -4.5, 1, 1,
    ]),
    indices: new Uint16Array([0, 1, 2, 1, 3, 2]),
  });
  const textures = Array.from({ length: 5 }, () => gl.createTexture());
  const upload = (index, image, mipmaps = false) => {
    gl.activeTexture(gl.TEXTURE0 + index);
    gl.bindTexture(gl.TEXTURE_2D, textures[index]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_WRAP_S,
      index === 4 ? gl.CLAMP_TO_EDGE : gl.REPEAT,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
    );
    if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
  };
  const atlas = document.createElement("canvas");
  atlas.width = 14 * 16;
  atlas.height = 24;
  const ctx = atlas.getContext("2d");
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, atlas.width, atlas.height);
  ctx.font = "bold 20px monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "white";
  [..." .,:;-=+*ox%#@"].forEach((c, i) => ctx.fillText(c, i * 16 + 8, 19));
  // Atlas mipmaps blend neighboring glyphs; use derivatives and a fixed atlas instead.
  upload(4, atlas);
  let scene,
    loadGeneration = 0;
  const settings = { mode: 1, geometry: 2, strength: 0.8 };
  const load = async (next) => {
    const ticket = ++loadGeneration;
    const images = await Promise.all(
      [next.neon, next.natural, next.seed].map(
        (url) =>
          new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () =>
              reject(new Error("Could not load experiment texture"));
            image.src = url;
          }),
      ),
    );
    if (ticket !== loadGeneration) return;
    scene = next;
    upload(0, images[0], true);
    upload(1, images[1], true);
    upload(2, images[2], true);
    // Blurred luminance is a deliberately modest relief hypothesis, not estimated 3D.
    const map = document.createElement("canvas");
    map.width = 256;
    map.height = 128;
    const c = map.getContext("2d");
    c.filter = "blur(6px)";
    c.drawImage(images[1], -256, 0, 256, 128);
    c.drawImage(images[1], 0, 0, 256, 128);
    c.drawImage(images[1], 256, 0, 256, 128);
    const data = c.getImageData(0, 0, 256, 128);
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4,
          h = next.head;
        const dx =
          Math.max(h.x - x / 256, x / 256 - h.x - h.width, 0) / h.featherX;
        const dy =
          Math.max(h.y - y / 128, y / 128 - h.y - h.height, 0) / h.featherY;
        const distance = Math.min(1, Math.max(dx, dy)),
          keep = distance * distance * (3 - 2 * distance);
        const value = Math.round(
          (data.data[i] * 0.2126 +
            data.data[i + 1] * 0.7152 +
            data.data[i + 2] * 0.0722) *
            keep,
        );
        data.data[i] = data.data[i + 1] = data.data[i + 2] = value;
      }
    c.putImageData(data, 0, 0);
    upload(3, map, true);
    camera.reset();
    camera.pitch = next.pitch;
    settings.strength = next.level === 3 ? 0.6 : next.level === 5 ? 0.82 : 0.95;
  };
  const drawMesh = (m) => {
    gl.bindVertexArray(m.vao);
    gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
  };
  const draw = () => {
    if (!scene) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.clearColor(0.01, 0.015, 0.04, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    textures.forEach((t, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
    });
    for (const [name, i] of [
      ["colorMap", 0],
      ["naturalMap", 1],
      ["seedMap", 2],
      ["heightMap", 3],
      ["glyphMap", 4],
    ])
      gl.uniform1i(u[name], i);
    const { view, projection } = camera.matrices(canvas.width / canvas.height);
    gl.uniformMatrix4fv(u.view, false, view);
    gl.uniformMatrix4fv(u.projection, false, projection);
    gl.uniform1f(u.relief, settings.geometry === 0 ? 0 : 0.65);
    gl.uniform1f(u.mode, settings.mode);
    gl.uniform1f(u.strength, settings.strength);
    const h = scene.head;
    gl.uniform4f(u.head, h.x, h.y, h.width, h.height);
    gl.uniform2f(u.feather, h.featherX, h.featherY);
    gl.uniform1f(u.surface, 0);
    drawMesh(sphere);
    if (settings.geometry === 2) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1f(u.surface, 2);
      drawMesh(floor);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.uniform1f(u.surface, 1);
      arches.forEach(drawMesh);
    }
  };
  const pixels = () => {
    const p = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(
      0,
      0,
      canvas.width,
      canvas.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      p,
    );
    return p;
  };
  const dispose = () => {
    textures.forEach((t) => gl.deleteTexture(t));
    meshes.forEach((m) => {
      gl.deleteBuffer(m.vb);
      gl.deleteBuffer(m.ib);
      gl.deleteVertexArray(m.vao);
    });
    gl.deleteProgram(program);
  };
  return { load, draw, pixels, camera, settings, gl, dispose };
}
