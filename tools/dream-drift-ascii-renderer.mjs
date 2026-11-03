// Isolated WebGL2 display experiment. No application controls or shaders change.
import { createDomeMesh, DomeCamera } from "../assets/js/render/dome-mesh.js";

export function createArchMesh({
  z = -3,
  radius = 1.7,
  tube = 0.045,
  uprightY = -1.35,
  archTopY = 0.12,
  steps = 40,
  sides = 8,
} = {}) {
  const path = [
    [-radius, uprightY],
    [-radius, archTopY],
  ];
  for (let i = 1; i <= steps; i++) {
    const a = Math.PI - (i / steps) * Math.PI;
    path.push([Math.cos(a) * radius, archTopY + Math.sin(a) * radius]);
  }
  path.push([radius, uprightY]);
  const vertices = [],
    indices = [];
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

export function createPortalMesh({
  z = -2.6,
  innerRadius = 1.6,
  width = 0.35,
  depth = 0.12,
  uprightY = -1.35,
  archTopY = 0.12,
  steps = 40,
} = {}) {
  const outerRadius = innerRadius + width;
  const vertices = [],
    indices = [];
  const innerPath = [
    [-innerRadius, uprightY],
    [-innerRadius, archTopY],
  ];
  const outerPath = [
    [-outerRadius, uprightY],
    [-outerRadius, archTopY],
  ];
  for (let i = 1; i <= steps; i++) {
    const a = Math.PI - (i / steps) * Math.PI;
    innerPath.push([
      Math.cos(a) * innerRadius,
      archTopY + Math.sin(a) * innerRadius,
    ]);
    outerPath.push([
      Math.cos(a) * outerRadius,
      archTopY + Math.sin(a) * outerRadius,
    ]);
  }
  innerPath.push([innerRadius, uprightY]);
  outerPath.push([outerRadius, uprightY]);

  for (let i = 0; i < innerPath.length; i++) {
    const [ix, iy] = innerPath[i],
      [ox, oy] = outerPath[i];
    const idx = vertices.length / 5;
    vertices.push(
      ix,
      iy,
      z,
      0.0,
      1.0,
      ox,
      oy,
      z,
      1.0,
      1.0,
      ix,
      iy,
      z - depth,
      0.0,
      0.0,
    );
    if (i < innerPath.length - 1) {
      indices.push(idx, idx + 1, idx + 3, idx + 1, idx + 4, idx + 3);
      indices.push(idx, idx + 3, idx + 2, idx + 3, idx + 5, idx + 2);
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
uniform float relief, surface, time;
out vec2 vUV;
out vec3 world;
void main(){
  vUV=uv;
  float h=textureLod(heightMap,uv,0.).r;
  float wave=sin(dot(position,vec3(2.3,1.9,1.1))+time*.16)*sin(dot(position,vec3(-1.5,2.1,.8))-time*.12);
  float r=surface<.5 ? (h*relief + wave*.035*relief) : 0.;
  world=surface<.5 ? position*(5.-r) : position;
  gl_Position=projection*view*vec4(world,1.);
}`;

const fragment = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2D colorMap, naturalMap, seedMap;
uniform sampler2DArray glyphMap;
uniform vec4 head;
uniform vec2 feather, grid;
uniform float mode, strength, surface, time, glyphCount;
uniform float archStyle, animMode, animSpeed;
in vec2 vUV;
in vec3 world;
out vec4 color;
float keepHead(vec2 uv){
  vec2 p=vec2(uv.x,1.-uv.y);
  vec2 d=max(head.xy-p,p-head.xy-head.zw);
  return 1.-smoothstep(0.,1.,max(d.x/feather.x,d.y/feather.y));
}
void main(){
  if(surface>1.5){
    // Depth-tested architectural floor.
    vec2 p=world.xz*2.;
    vec2 d=abs(fract(p-.5)-.5)/max(fwidth(p),vec2(.0001));
    float line=1.-min(min(d.x,d.y),1.);
    color=vec4(mix(vec3(.012,.018,.055),vec3(.03,.35,.45),line*.6),.62);
    return;
  }
  if(surface>.5){
    // Equirectangular projection so archway seamlessly maps to the photo behind it
    float len = length(world);
    float scU = fract(atan(world.x, -world.z) / 6.2831853 + 0.5);
    float scV = asin(clamp(world.y / max(len, 0.001), -0.999, 0.999)) / 3.14159265 + 0.5;
    vec2 sceneUV = vec2(scU, scV);
    vec3 sceneCol = texture(colorMap, sceneUV).rgb;
    float sceneLuma = dot(sceneCol, vec3(.2126, .7152, .0722));
    float rim = pow(1.0 - abs(vUV.x), 2.0);

    // Style 5: Original Neon Wire
    if(archStyle > 4.5){
      vec3 c = mix(vec3(.04, .95, 1.), vec3(.7, .08, 1.), smoothstep(-1.7, 1.7, world.x));
      color = vec4(c * (.55 + .45 * abs(vUV.x)), 1.);
      return;
    }

    // Style 0: Photographic Vault (Seamless image extrusion with luminous rim)
    if(archStyle < 0.5){
      vec3 rimCol = mix(vec3(.35, .85, 1.), vec3(1., .65, .3), smoothstep(-1.5, 1.5, world.x));
      vec3 archCol = mix(sceneCol * 1.25 + vec3(.02), rimCol, rim * 0.55);
      float pulse = 0.95 + 0.08 * sin(time * 1.5 + world.x * 2.0);
      color = vec4(archCol * pulse, 1.);
      return;
    }

    // Style 1: Woven ASCII Gateway (The archway itself is covered in woven characters)
    if(archStyle < 1.5){
      vec2 aCell = floor(sceneUV * grid), aLocal = fract(sceneUV * grid);
      vec2 adx = dFdx(sceneUV) * grid, ady = dFdy(sceneUV) * grid;
      float aPhase = dot(normalize(world), vec3(2.1, -1.3, 1.7));
      float aChoice = clamp(1.0 + sceneLuma * (glyphCount - 3.0) + 0.7 * sin(time * 0.17 + aPhase), 0.0, glyphCount - 1.001);
      float aRank = floor(aChoice), aBlend = fract(aChoice);
      float aGlyphA = textureGrad(glyphMap, vec3(aLocal, aRank), adx, ady).r;
      float aGlyphB = textureGrad(glyphMap, vec3(aLocal, min(aRank + 1.0, glyphCount - 1.0)), adx, ady).r;
      float aInk = mix(aGlyphA, aGlyphB, smoothstep(0.0, 1.0, aBlend));
      vec3 aCool = mix(vec3(.12, .88, 1.), vec3(1., .25, .79), 0.5 + 0.5 * sin(aPhase * 0.8 + time * 0.075));
      vec3 aGround = max(sceneCol * 0.85 + aCool * 0.08, aCool * 0.15 + vec3(0.04));
      vec3 aPigment = clamp(mix(sceneCol, aCool, 0.85) * 1.1 + aCool * 0.1, 0.0, 1.0);
      vec3 aWoven = mix(aGround, aPigment, aInk * 0.9);
      color = vec4(mix(aWoven, aCool, rim * 0.4), 1.);
      return;
    }

    // Style 2: 5-Rib Colonnade (Corridor ribs with depth gradient)
    if(archStyle < 2.5){
      float depthFade = smoothstep(-1.5, -4.5, world.z);
      vec3 ribTint = mix(sceneCol * 1.25, vec3(.08, .75, 1.), depthFade * 0.65);
      vec3 ribCol = mix(ribTint, vec3(1., .3, .8), rim * 0.5);
      float ribPulse = 0.92 + 0.12 * sin(time * 2.0 + world.z * 3.0);
      color = vec4(ribCol * ribPulse, 1.);
      return;
    }

    // Style 3: Carved Proscenium Portal (Beveled doorway frame)
    if(archStyle < 3.5){
      float isBevel = vUV.y < 0.5 ? 1.0 : 0.0;
      vec3 bevelCol = mix(sceneCol * 0.75, vec3(.05, .4, .6), 0.35);
      vec3 faceCol = mix(sceneCol * 1.2, vec3(.2, .9, 1.), rim * 0.4);
      vec3 portalCol = mix(faceCol, bevelCol, isBevel);
      color = vec4(portalCol, 1.);
      return;
    }

    // Style 4: Frosted Glass Threshold
    vec3 frosted = mix(sceneCol, vec3(.4, .85, 1.), 0.35);
    color = vec4(mix(frosted, vec3(1.), rim * 0.65), 0.75);
    return;
  }
  vec3 base=texture(colorMap,vUV).rgb;
  if(mode<.5){color=vec4(base,1.);return;}

  vec2 cell=floor(vUV*grid), center=(cell+.5)/grid, local=fract(vUV*grid);
  vec2 dx=dFdx(vUV)*grid, dy=dFdy(vUV)*grid;
  vec3 sampleColor=textureLod(colorMap,center,0.).rgb;
  float light=dot(sampleColor,vec3(.2126,.7152,.0722));

  float t = time * animSpeed;
  float phase = dot(normalize(world), vec3(2.1, -1.3, 1.7));

  // Base choice calculation for each animMode
  float choice = clamp(1.0 + light * (glyphCount - 3.0) + 0.7 * sin(t * 0.17 + phase), 0.0, glyphCount - 1.001);

  if(animMode > 1.5 && animMode < 2.5){
    // Mode 2: Cortical Wave Ripple (Harmonic traveling wave)
    float wave = sin(cell.x * 0.12 + cell.y * 0.16 - t * 2.8) * 0.16 + sin(cell.x * 0.06 - cell.y * 0.10 - t * 1.5) * 0.09;
    choice = clamp(1.0 + clamp(light + wave, 0.0, 0.999) * (glyphCount - 3.0) + 0.5 * sin(t * 0.2 + phase), 0.0, glyphCount - 1.001);
  } else if(animMode > 2.5 && animMode < 3.5){
    // Mode 3: Neural Shimmer Pulse (Subtle breathing pulse)
    float shimmer = 0.5 + 0.5 * sin(t * 2.0 + dot(cell, vec2(0.08, 0.12)));
    choice = clamp(1.0 + (light + (shimmer - 0.5) * 0.18) * (glyphCount - 3.0) + 0.6 * sin(t * 0.25 + phase), 0.0, glyphCount - 1.001);
  } else if(animMode > 3.5){
    // Mode 4: Cascade Matrix Stream (Woven downward stream)
    float colPhase = fract(sin(cell.x * 91.34) * 473.12);
    float cascade = fract(cell.y / grid.y - t * 0.28 + colPhase);
    float streamBoost = smoothstep(0.72, 1.0, cascade) * 0.26;
    choice = clamp(1.0 + clamp(light + streamBoost, 0.0, 0.999) * (glyphCount - 3.0) + 0.4 * sin(t * 0.15 + phase), 0.0, glyphCount - 1.001);
  } else if(animMode < 0.5){
    // Mode 0: Static (Pause flow)
    choice = clamp(1.0 + light * (glyphCount - 3.0), 0.0, glyphCount - 1.001);
  }

  float rank=floor(choice), blend=fract(choice);
  float a=textureGrad(glyphMap,vec3(local,rank),dx,dy).r;
  float b=textureGrad(glyphMap,vec3(local,min(rank+1.,glyphCount-1.)),dx,dy).r;
  float ink=mix(a,b,smoothstep(0.,1.,blend));

  vec3 cool=mix(vec3(.12,.88,1.),vec3(1.,.25,.79),.5+.5*sin(phase*.8+t*.075));
  // Keep colored image information between strokes instead of black rectangles: the woven look.
  vec3 ground=max(mix(base,sampleColor,.45)*.87+cool*.065,cool*.14+vec3(.04));
  float inkGain=mix(1.1,.40,smoothstep(.12,.8,light));
  vec3 pigment=clamp(mix(sampleColor,cool,.85)*inkGain+cool*.08,0.,1.);
  vec3 woven=mix(ground,pigment,ink*.9);

  vec3 delta=textureLod(naturalMap,center,0.).rgb-textureLod(seedMap,center,0.).rgb;
  float change=smoothstep(.015,.16,length(delta));
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

export function createAsciiRenderer(canvas) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error("This experiment requires WebGL2.");
  const program = makeProgram(gl),
    camera = new DomeCamera();
  const uniformNames = [
    "view",
    "projection",
    "colorMap",
    "naturalMap",
    "seedMap",
    "heightMap",
    "glyphMap",
    "relief",
    "surface",
    "mode",
    "strength",
    "head",
    "feather",
    "grid",
    "time",
    "glyphCount",
    "archStyle",
    "animMode",
    "animSpeed",
  ];
  const u = Object.fromEntries(
    uniformNames.map((n) => [n, gl.getUniformLocation(program, n)]),
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
  const neonArches = [
    mesh(createArchMesh()),
    mesh(createArchMesh({ z: -4.05, radius: 1.45, tube: 0.035 })),
  ];
  const photoArches = [
    mesh(createArchMesh({ z: -2.8, radius: 1.72, tube: 0.075 })),
    mesh(createArchMesh({ z: -4.0, radius: 1.48, tube: 0.06 })),
  ];
  const ribsArches = [
    mesh(createArchMesh({ z: -1.8, radius: 1.85, tube: 0.04 })),
    mesh(createArchMesh({ z: -2.4, radius: 1.75, tube: 0.04 })),
    mesh(createArchMesh({ z: -3.0, radius: 1.65, tube: 0.04 })),
    mesh(createArchMesh({ z: -3.6, radius: 1.55, tube: 0.04 })),
    mesh(createArchMesh({ z: -4.2, radius: 1.45, tube: 0.04 })),
  ];
  const portalArches = [mesh(createPortalMesh())];
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
  gl.activeTexture(gl.TEXTURE4);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, textures[4]);
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
  let scene,
    loadGeneration = 0;
  const settings = {
    mode: 1,
    geometry: 2,
    strength: 0.8,
    columns: 320,
    rows: 112,
    archStyle: 0,
    animMode: 1,
    animSpeed: 1.0,
  };
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
  const draw = (currentTime = 0) => {
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
      gl.bindTexture(i === 4 ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D, t);
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
    gl.uniform2f(u.grid, settings.columns, settings.rows);
    gl.uniform1f(u.time, currentTime);
    gl.uniform1f(u.glyphCount, glyphs.length);
    gl.uniform1f(u.archStyle, settings.archStyle);
    gl.uniform1f(u.animMode, settings.animMode);
    gl.uniform1f(u.animSpeed, settings.animSpeed);
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
      gl.uniform1f(u.surface, 1);
      const activeArches =
        settings.archStyle === 5
          ? neonArches
          : settings.archStyle === 2
            ? ribsArches
            : settings.archStyle === 3
              ? portalArches
              : photoArches;
      activeArches.forEach(drawMesh);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
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
