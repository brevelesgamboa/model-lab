// Isolated WebGL2 display experiment. No application controls or shaders change.
import { createDomeMesh, DomeCamera } from "../assets/js/render/dome-mesh.js";

export const GLYPH_SETS = Object.freeze({
  hex: " 0123456789ABCDEF",
  classic: " .,:;-=+*ox%#@",
  technical: " .:0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ#$%@",
});

// Shared by both surfaces. Positive time moves the band toward decreasing V.
// A periodic cosine envelope avoids a bright-to-dark jump at a fract() wrap.
export const RAIN_GLSL = `
float rainSignal(vec2 cell, vec2 density, float clock){
  float offset=fract(sin(cell.x*91.34)*473.12);
  float phase=(cell.y+.5)/density.y+clock*.18+offset;
  float head=pow(.5+.5*cos(phase*6.2831853),10.);
  float trail=pow(.5+.5*cos((phase-.12)*6.2831853),3.);
  return clamp(head*.75+trail*.25,0.,1.);
}`;

export const IMAGE_COLOR_GLSL = `
vec3 imageVibrance(vec3 c, float saturation){
  float y=dot(c,vec3(.2126,.7152,.0722));
  vec3 chroma=c-vec3(y);
  float gain=saturation;
  for(int i=0;i<3;i++){
    if(chroma[i]>.00001)gain=min(gain,(1.-y)/chroma[i]);
    if(chroma[i]<-.00001)gain=min(gain,-y/chroma[i]);
  }
  return clamp(vec3(y)+chroma*gain,0.,1.);
}
vec3 imageHue(vec3 c,vec3 fallback){
  if(max(max(c.r,c.g),c.b)<.015)c=fallback;
  return c/max(max(max(c.r,c.g),c.b),.001);
}
vec3 hueLuminance(vec3 hue,float target){
  vec3 c=hue*target/max(dot(hue,vec3(.2126,.7152,.0722)),.015);
  return c/max(1.,max(max(c.r,c.g),c.b));
}`;

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
uniform float relief, surface, time, archStyle, breathing;
out vec2 vUV;
out vec3 world;
void main(){
  vUV=uv;
  float h=textureLod(heightMap,uv,0.).r;
  float wave=sin(dot(position,vec3(2.3,1.9,1.1))+time*.16)*sin(dot(position,vec3(-1.5,2.1,.8))-time*.12);
  float r=surface<.5 ? (h*relief + wave*.035*relief) : 0.;
  vec3 p=position;
  if(surface>.5&&surface<1.5&&archStyle>.5&&archStyle<1.5){
    float breath=sin(time*.28)*.012*breathing;
    p.x*=1.+breath;
    p.y=-1.35+(position.y+1.35)*(1.+breath*.5);
  }
  world=surface<.5 ? position*(5.-r) : p;
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
uniform float archStyle, animMode, animSpeed, vibrancy, paletteMode;
uniform vec3 averageColor;
in vec2 vUV;
in vec3 world;
out vec4 color;
${RAIN_GLSL}
${IMAGE_COLOR_GLSL}
vec2 sceneUV(vec3 point){
  vec3 dir=point/max(length(point),.001);
  return vec2(fract(atan(dir.x,-dir.z)/6.2831853+.5),asin(clamp(dir.y,-1.,1.))/3.14159265+.5);
}
vec3 imageAt(vec2 uv){
  vec3 natural=texture(naturalMap,uv).rgb;
  vec3 neon=texture(colorMap,uv).rgb;
  return imageVibrance(mix(natural,neon,paletteMode),vibrancy);
}
vec3 imageCell(vec2 uv){
  vec3 c=mix(textureLod(naturalMap,uv,0.).rgb,textureLod(colorMap,uv,0.).rgb,paletteMode);
  return imageVibrance(c,vibrancy);
}
vec3 wovenImage(vec2 uv,vec3 base){
  vec2 cell=floor(uv*grid),center=(cell+.5)/grid,local=fract(uv*grid);
  vec2 dx=dFdx(uv),dy=dFdy(uv);
  dx.x-=round(dx.x);dy.x-=round(dy.x);
  dx*=grid;dy*=grid;
  vec3 sampleColor=imageCell(center);
  float light=dot(sampleColor,vec3(.2126,.7152,.0722));
  float t=time*animSpeed;
  // One scene projection, clock and cell grid for the dome and the gateway.
  vec3 dir=vec3(sin((center.x-.5)*6.2831853)*cos((center.y-.5)*3.14159265),sin((center.y-.5)*3.14159265),-cos((center.x-.5)*6.2831853)*cos((center.y-.5)*3.14159265));
  float phase=dot(dir,vec3(2.1,-1.3,1.7));
  float signal=0.;
  float value=light;
  if(animMode>1.5&&animMode<2.5){
    value+=sin(cell.x*.12+cell.y*.16-t*2.8)*.16+sin(cell.x*.06-cell.y*.10-t*1.5)*.09;
  }else if(animMode>2.5&&animMode<3.5){
    value+=sin(t*2.+dot(cell,vec2(.08,.12)))*.09;
  }else if(animMode>3.5){
    signal=rainSignal(cell,grid,t);
    value+=signal*.18;
  }
  float drift=animMode<.5?0.:.65*sin(t*.17+phase);
  float choice=clamp(clamp(value,0.,1.)*(glyphCount-1.)+drift,0.,glyphCount-1.001);
  float rank=floor(choice),blend=smoothstep(0.,1.,fract(choice));
  float a=textureGrad(glyphMap,vec3(local,rank),dx,dy).r;
  float b=textureGrad(glyphMap,vec3(local,min(rank+1.,glyphCount-1.)),dx,dy).r;
  float ink=mix(a,b,blend);
  vec3 hue=imageHue(sampleColor,averageColor);
  vec3 ground=max(mix(base,sampleColor,.45)*.92,hue*.11);
  float inkLight=mix(.85,.25,smoothstep(.12,.8,light));
  vec3 pigment=hueLuminance(hue,inkLight*(1.+signal*.16));
  return mix(ground,pigment,ink*.94);
}
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
    vec3 photo=imageAt(sceneUV(world)),hue=imageHue(photo,averageColor);
    color=vec4(mix(max(photo*.60,hue*.10),hueLuminance(hue,.55),line*.45),.30);
    return;
  }
  if(surface>.5){
    // Equirectangular projection so archway seamlessly maps to the photo behind it
    vec2 uv=sceneUV(world);
    vec3 sceneCol=imageAt(uv);
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
      vec3 rimCol=hueLuminance(imageHue(sceneCol,averageColor),.8);
      vec3 archCol = mix(sceneCol * 1.25 + vec3(.02), rimCol, rim * 0.55);
      float pulse = 0.95 + 0.08 * sin(time * 1.5 + world.x * 2.0);
      color = vec4(archCol * pulse, 1.);
      return;
    }

    // Style 1: Woven ASCII Gateway (The archway itself is covered in woven characters)
    if(archStyle < 1.5){
      vec3 woven=wovenImage(uv,sceneCol);
      vec3 rimColor=hueLuminance(imageHue(sceneCol,averageColor),min(.95,sceneLuma+.28));
      float curvature=.76+.12*abs(vUV.x);
      color=vec4(mix(woven*curvature,rimColor,rim*.30),1.);
      return;
    }

    // Style 2: 5-Rib Colonnade (Corridor ribs with depth gradient)
    if(archStyle < 2.5){
      float depthFade = smoothstep(1.5,4.5,-world.z);
      vec3 ribTint=sceneCol*(1.15-depthFade*.15);
      vec3 ribCol=mix(ribTint,hueLuminance(imageHue(sceneCol,averageColor),.8),rim*.25);
      float ribPulse = 0.92 + 0.12 * sin(time * 2.0 + world.z * 3.0);
      color = vec4(ribCol * ribPulse, 1.);
      return;
    }

    // Style 3: Carved Proscenium Portal (Beveled doorway frame)
    if(archStyle < 3.5){
      float isBevel = vUV.y < 0.5 ? 1.0 : 0.0;
      vec3 bevelCol=sceneCol*.75;
      vec3 faceCol=mix(sceneCol,hueLuminance(imageHue(sceneCol,averageColor),.8),rim*.25);
      vec3 portalCol = mix(faceCol, bevelCol, isBevel);
      color = vec4(portalCol, 1.);
      return;
    }

    // Style 4: Frosted Glass Threshold
    vec3 frosted=sceneCol*.9+averageColor*.1;
    color=vec4(mix(frosted,hueLuminance(imageHue(sceneCol,averageColor),.9),rim*.4),.75);
    return;
  }
  vec2 uv=sceneUV(world);
  vec3 base=imageAt(uv);
  if(mode<.5){color=vec4(base,1.);return;}

  vec2 center=(floor(uv*grid)+.5)/grid;
  vec3 woven=wovenImage(uv,base);
  vec3 delta=textureLod(naturalMap,center,0.).rgb-textureLod(seedMap,center,0.).rgb;
  float change=smoothstep(.015,.16,length(delta));
  float amount=mode>1.5 ? 1. : strength*(.72+.28*change)*(1.-keepHead(uv));
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
    "vibrancy",
    "paletteMode",
    "averageColor",
    "breathing",
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
  const ctx = atlas.getContext("2d");
  let glyphs = [],
    activeGlyphSet;
  function updateGlyphSet(id) {
    if (id === activeGlyphSet) return;
    const characters = GLYPH_SETS[id];
    if (!characters) throw new RangeError("Unknown glyph set: " + id);
    glyphs = [];
    for (const character of characters) {
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
    activeGlyphSet = id;
  }
  updateGlyphSet("hex");
  let scene,
    loadGeneration = 0,
    averageColor = [0.5, 0.5, 0.5];
  const settings = {
    mode: 1,
    geometry: 2,
    strength: 0.8,
    columns: 320,
    rows: 112,
    archStyle: 1,
    animMode: 4,
    animSpeed: 1.8,
    glyphSet: "hex",
    vibrancy: 1.25,
    paletteMode: 0,
    breathing: 1,
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
    const sums = [0, 0, 0];
    for (let i = 0; i < data.data.length; i += 4)
      for (let k = 0; k < 3; k++) sums[k] += data.data[i + k];
    averageColor = sums.map((sum) => sum / (256 * 128 * 255));
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
    updateGlyphSet(settings.glyphSet);
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
    gl.uniform1f(u.time, settings.animMode === 0 ? 0 : currentTime);
    gl.uniform1f(u.glyphCount, glyphs.length);
    gl.uniform1f(u.archStyle, settings.archStyle);
    gl.uniform1f(u.animMode, settings.animMode);
    gl.uniform1f(u.animSpeed, settings.animSpeed);
    gl.uniform1f(u.vibrancy, settings.vibrancy);
    gl.uniform1f(u.paletteMode, settings.paletteMode);
    gl.uniform3fv(u.averageColor, averageColor);
    gl.uniform1f(u.breathing, settings.breathing);
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
  return {
    load,
    draw,
    pixels,
    camera,
    settings,
    gl,
    dispose,
    get glyphs() {
      return glyphs.map(({ character, coverage }) => ({ character, coverage }));
    },
  };
}
