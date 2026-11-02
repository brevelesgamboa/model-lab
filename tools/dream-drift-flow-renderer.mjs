// Colored, slowly evolving ASCII on one continuous image-derived surface.
// Experiment only: uses cached model outputs, never calls inference.
import { createDomeMesh, DomeCamera } from "../assets/js/render/dome-mesh.js";

export function flowState(seconds, animated = true) {
  if (!Number.isFinite(seconds)) throw new RangeError("Time must be finite.");
  const time = animated ? seconds : 0;
  return { time, modelBlend: 0.5 + 0.5 * Math.cos((time * Math.PI) / 20) };
}

const vertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 position;
layout(location=1) in vec2 uv;
uniform mat4 view,projection;
uniform sampler2D fieldMap;
uniform vec4 head;
uniform vec2 feather;
uniform float geometry,time,modelBlend;
out vec2 vUV;
out vec3 direction;
float headKeep(vec2 uv){
  vec2 p=vec2(uv.x,1.-uv.y);
  vec2 d=max(head.xy-p,p-head.xy-head.zw);
  return 1.-smoothstep(0.,1.,max(d.x/feather.x,d.y/feather.y));
}
void main(){
  vUV=uv;direction=position;
  vec2 fields=textureLod(fieldMap,uv,0.).rg;
  float height=mix(fields.r,fields.g,modelBlend);
  float wave=sin(dot(position,vec3(2.3,1.9,1.1))+time*.16)*sin(dot(position,vec3(-1.5,2.1,.8))-time*.12);
  float relief=geometry<.5 ? 0. : height*.48;
  if(geometry>1.5) relief+=wave*.075*(1.-headKeep(uv));
  gl_Position=projection*view*vec4(position*(5.-relief),1.);
}`;

const fragment = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2D previousMap,currentMap,fieldMap;
uniform sampler2DArray glyphMap;
uniform vec4 head;
uniform vec2 feather,grid;
uniform float mode,strength,time,modelBlend,glyphCount;
in vec2 vUV;
in vec3 direction;
out vec4 color;
float keepHead(vec2 uv){
  vec2 p=vec2(uv.x,1.-uv.y);
  vec2 d=max(head.xy-p,p-head.xy-head.zw);
  return 1.-smoothstep(0.,1.,max(d.x/feather.x,d.y/feather.y));
}
vec3 source(vec2 uv){return mix(texture(previousMap,uv).rgb,texture(currentMap,uv).rgb,modelBlend);}
void main(){
  vec3 base=source(vUV);
  if(mode<.5){color=vec4(base,1.);return;}
  vec2 cell=floor(vUV*grid),center=(cell+.5)/grid,local=fract(vUV*grid);
  vec2 dx=dFdx(vUV)*grid,dy=dFdy(vUV)*grid;
  vec3 sampleColor=source(center);
  float light=dot(sampleColor,vec3(.2126,.7152,.0722));
  // Cross-fade neighboring glyphs continuously. Cell positions never jitter.
  float phase=dot(normalize(direction),vec3(2.1,-1.3,1.7));
  float choice=clamp(1.+light*(glyphCount-3.)+.7*sin(time*.17+phase),0.,glyphCount-1.001);
  float rank=floor(choice),blend=fract(choice);
  float a=textureGrad(glyphMap,vec3(local,rank),dx,dy).r;
  float b=textureGrad(glyphMap,vec3(local,min(rank+1.,glyphCount-1.)),dx,dy).r;
  float ink=mix(a,b,smoothstep(0.,1.,blend));
  vec3 cool=mix(vec3(.12,.88,1.),vec3(1.,.25,.79),.5+.5*sin(phase*.8+time*.075));
  // Keep colored image information between strokes instead of black rectangles.
  vec3 ground=max(mix(base,sampleColor,.45)*.87+cool*.065,cool*.14+vec3(.04));
  float inkGain=mix(1.1,.40,smoothstep(.12,.8,light));
  vec3 pigment=clamp(mix(sampleColor,cool,.85)*inkGain+cool*.08,0.,1.);
  vec3 woven=mix(ground,pigment,ink*.9);
  float change=texture(fieldMap,center).b;
  float amount=mode>1.5 ? 1. : strength*(.72+.28*change)*(1.-keepHead(vUV));
  color=vec4(mix(base,woven,amount),1.);
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

export function createFlowRenderer(canvas) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error("WebGL2 is required for this experiment.");
  const program = makeProgram(gl),
    camera = new DomeCamera(),
    mesh = createDomeMesh(192);
  const vao = gl.createVertexArray(),
    vb = gl.createBuffer(),
    ib = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  const uniformNames = [
    "view",
    "projection",
    "fieldMap",
    "previousMap",
    "currentMap",
    "glyphMap",
    "head",
    "feather",
    "grid",
    "geometry",
    "time",
    "modelBlend",
    "glyphCount",
    "mode",
    "strength",
  ];
  const u = Object.fromEntries(
    uniformNames.map((n) => [n, gl.getUniformLocation(program, n)]),
  );
  const textures = Array.from({ length: 4 }, () => gl.createTexture());
  function upload(index, image) {
    gl.activeTexture(gl.TEXTURE0 + index);
    gl.bindTexture(gl.TEXTURE_2D, textures[index]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR,
    );
    gl.generateMipmap(gl.TEXTURE_2D);
  }
  // Each glyph has its own mipmapped array layer: no bleeding between characters.
  const atlas = document.createElement("canvas");
  atlas.width = 32;
  atlas.height = 48;
  const ctx = atlas.getContext("2d"),
    glyphs = [];
  for (const character of " .,:;-=+*ox%#@") {
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, 32, 48);
    ctx.fillStyle = "white";
    ctx.font = "bold 40px monospace";
    ctx.textAlign = "center";
    ctx.fillText(character, 16, 38);
    const rgba = ctx.getImageData(0, 0, 32, 48).data,
      red = new Uint8Array(32 * 48);
    let coverage = 0;
    for (let y = 0; y < 48; y++)
      for (let x = 0; x < 32; x++) {
        const value = rgba[((47 - y) * 32 + x) * 4];
        red[y * 32 + x] = value;
        coverage += value;
      }
    glyphs.push({ character, red, coverage });
  }
  glyphs.sort((a, b) => a.coverage - b.coverage);
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, textures[3]);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(
    gl.TEXTURE_2D_ARRAY,
    0,
    gl.R8,
    32,
    48,
    glyphs.length,
    0,
    gl.RED,
    gl.UNSIGNED_BYTE,
    null,
  );
  glyphs.forEach((g, i) =>
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      0,
      0,
      i,
      32,
      48,
      1,
      gl.RED,
      gl.UNSIGNED_BYTE,
      g.red,
    ),
  );
  gl.texParameteri(
    gl.TEXTURE_2D_ARRAY,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR,
  );
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  const settings = {
    mode: 1,
    geometry: 2,
    strength: 0.8,
    columns: 320,
    rows: 112,
    animated: true,
  };
  let scene,
    generation = 0;
  async function load(next) {
    const ticket = ++generation;
    const images = await Promise.all(
      [
        next.previous,
        next.current,
        next.previousNatural,
        next.currentNatural,
        next.seed,
      ].map(
        (url) =>
          new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () =>
              reject(new Error("Could not load model image"));
            image.src = url;
          }),
      ),
    );
    if (ticket !== generation) return;
    scene = next;
    upload(0, images[0]);
    upload(1, images[1]);
    const field = document.createElement("canvas");
    field.width = 256;
    field.height = 128;
    const c = field.getContext("2d"),
      maps = [];
    for (const image of images.slice(2)) {
      c.clearRect(0, 0, 256, 128);
      c.filter = "blur(5px)";
      for (const x of [-256, 0, 256]) c.drawImage(image, x, 0, 256, 128);
      maps.push(c.getImageData(0, 0, 256, 128).data);
    }
    const data = c.createImageData(256, 128),
      h = next.head;
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4,
          dx = Math.max(h.x - x / 256, x / 256 - h.x - h.width, 0) / h.featherX,
          dy =
            Math.max(h.y - y / 128, y / 128 - h.y - h.height, 0) / h.featherY;
        const d = Math.min(1, Math.max(dx, dy)),
          free = d * d * (3 - 2 * d);
        const light = (m) =>
          m[i] * 0.2126 + m[i + 1] * 0.7152 + m[i + 2] * 0.0722;
        data.data[i] = Math.round(light(maps[0]) * free);
        data.data[i + 1] = Math.round(light(maps[1]) * free);
        let change = 0;
        for (let k = 0; k < 3; k++)
          change += Math.abs(maps[1][i + k] - maps[2][i + k]);
        data.data[i + 2] = Math.min(255, change * 2);
        data.data[i + 3] = 255;
      }
    c.putImageData(data, 0, 0);
    upload(2, field);
    camera.reset();
    camera.pitch = next.pitch;
    settings.strength =
      next.level === 3 ? 0.62 : next.level === 5 ? 0.82 : 0.95;
  }
  function draw(seconds = 0) {
    if (!scene) return;
    const state = flowState(seconds, settings.animated),
      h = scene.head;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0.08, 0.1, 0.14, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    textures.forEach((t, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(i === 3 ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D, t);
    });
    for (const [name, index] of [
      ["previousMap", 0],
      ["currentMap", 1],
      ["fieldMap", 2],
      ["glyphMap", 3],
    ])
      gl.uniform1i(u[name], index);
    const { view, projection } = camera.matrices(canvas.width / canvas.height);
    gl.uniformMatrix4fv(u.view, false, view);
    gl.uniformMatrix4fv(u.projection, false, projection);
    gl.uniform4f(u.head, h.x, h.y, h.width, h.height);
    gl.uniform2f(u.feather, h.featherX, h.featherY);
    gl.uniform2f(u.grid, settings.columns, settings.rows);
    for (const [name, value] of [
      ["geometry", settings.geometry],
      ["time", state.time],
      ["modelBlend", state.modelBlend],
      ["glyphCount", glyphs.length],
      ["mode", settings.mode],
      ["strength", settings.strength],
    ])
      gl.uniform1f(u[name], value);
    gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0);
  }
  function pixels() {
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
  }
  function dispose() {
    textures.forEach((t) => gl.deleteTexture(t));
    gl.deleteBuffer(vb);
    gl.deleteBuffer(ib);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
  }
  return {
    load,
    draw,
    pixels,
    settings,
    camera,
    gl,
    dispose,
    glyphs: glyphs.map(({ character, coverage }) => ({ character, coverage })),
    triangleCount: mesh.indices.length / 3,
  };
}
