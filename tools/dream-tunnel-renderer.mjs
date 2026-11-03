// Playable display experiment: open swept geometry, a level floor and a bounded
// render window. The geometry is authored; cached/live model output is imagery.
import { createDomeMesh, DomeCamera } from "../assets/js/render/dome-mesh.js";
import {
  createArchMesh,
  createPortalMesh,
  RAIN_GLSL,
  IMAGE_COLOR_GLSL,
  GLYPH_SETS,
} from "./dream-drift-ascii-renderer.mjs";
import {
  tunnelFrame,
  tunnelRadius,
  tunnelSite,
} from "./dream-tunnel-route.mjs";

export const TUNNEL_STYLES = [
  "Photographic vault",
  "Woven gateway",
  "Five-rib colonnade",
  "Carved portal",
  "Glass threshold",
  "Neon wire",
];
export const TUNNEL_FLOOR = -1.35;

// No end caps: each strip joins its neighbors and the camera follows its center.
export function createTunnelStrip(
  start,
  end,
  origin,
  { floor = false, steps = 16, sides = 32 } = {},
) {
  const vertices = [],
    indices = [],
    cross = floor ? 1 : sides + 2;
  for (let i = 0; i <= steps; i++) {
    const p = start + ((end - start) * i) / steps,
      frame = tunnelFrame(p, origin),
      r = tunnelRadius(p);
    for (let j = 0; j <= cross; j++) {
      let x, y;
      if (floor) {
        x = (j * 2 - 1) * r;
        y = TUNNEL_FLOOR;
      } else if (j === 0) {
        x = -r;
        y = TUNNEL_FLOOR;
      } else if (j === cross) {
        x = r;
        y = TUNNEL_FLOOR;
      } else {
        const a = Math.PI * (1 - (j - 1) / sides);
        x = Math.cos(a) * r;
        y = 0.12 + Math.sin(a) * r;
      }
      vertices.push(
        frame.position[0] + frame.right[0] * x,
        y,
        frame.position[1] + frame.right[1] * x,
        j / cross,
        (p - origin + (origin % 64)) * 18,
      );
      if (i < steps && j < cross) {
        const a = i * (cross + 1) + j,
          b = a + cross + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  return {
    vertices: new Float32Array(vertices),
    indices: new Uint16Array(indices),
  };
}

export function createTunnelArch(parameter, origin, style) {
  const frame = tunnelFrame(parameter, origin),
    radius = tunnelRadius(parameter) - 0.11;
  const data =
    style === 3
      ? createPortalMesh({
          z: 0,
          innerRadius: radius - 0.13,
          width: 0.23,
          depth: 0.14,
        })
      : createArchMesh({
          z: 0,
          radius,
          tube: style === 1 ? 0.12 : style === 5 ? 0.025 : 0.065,
        });
  for (let i = 0; i < data.vertices.length; i += 5) {
    const x = data.vertices[i],
      z = data.vertices[i + 2];
    data.vertices[i] =
      frame.position[0] + frame.right[0] * x + frame.forward[0] * z;
    data.vertices[i + 2] =
      frame.position[1] + frame.right[1] * x + frame.forward[1] * z;
  }
  return { ...data, frame, style };
}

const tunnelVertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 position;
layout(location=1) in vec2 uv;
uniform mat4 view, projection;
uniform vec3 eye, archCenter;
uniform vec2 archRight;
uniform float surface, time, style;
out vec2 vUV;
out vec3 world;
void main(){
  vec3 p=position;
  if(surface<.5)p=p*80.+eye;
  if(surface>2.5&&style>.5&&style<1.5){
    float breath=sin(time*.28)*.012;
    p.xz+=archRight*dot(p.xz-archCenter.xz,archRight)*breath;
    p.y=-1.35+(p.y+1.35)*(1.+breath*.5);
  }
  world=p;vUV=uv;gl_Position=projection*view*vec4(p,1.);
}`;

const tunnelFragment = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2D naturalA,neonA,naturalB,neonB;
uniform sampler2DArray glyphMap;
uniform vec3 eye;
uniform vec2 grid;
uniform float time,blend,neon,hex,corruption,fractal,surface,style,opacity,inversion,warp,glyphCount,archAlpha;
in vec2 vUV;
in vec3 world;
out vec4 color;
${RAIN_GLSL}
${IMAGE_COLOR_GLSL}
vec2 sceneUV(vec3 p){vec3 d=normalize(p-eye);return vec2(fract((atan(d.x,-d.z)+1.5707963)/6.2831853+.5),asin(clamp(d.y,-1.,1.))/3.14159265+.5);}
vec3 imageAt(vec2 uv){
  vec3 a=mix(texture(naturalA,uv).rgb,texture(neonA,uv).rgb,neon);
  vec3 b=mix(texture(naturalB,uv).rgb,texture(neonB,uv).rgb,neon);
  return imageVibrance(mix(a,b,blend),mix(1.,1.6,neon));
}
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
vec3 woven(vec2 uv,vec3 base){
  vec2 cell=floor(uv*grid),local=fract(uv*grid),center=(cell+.5)/grid;
  vec2 dx=dFdx(uv),dy=dFdy(uv);dx.x-=round(dx.x);dy.x-=round(dy.x);dx*=grid;dy*=grid;
  float clock=time*1.8,signal=rainSignal(cell,grid,clock);
  // Deeper corruption: smoothly drifting rows, ghosted glyphs and dropped ink.
  // The colors and background persist; corruption never blacks out the room.
  float drift=sin(cell.y*.09+clock*.32)*sin(clock*.15+cell.y*.017)*corruption;
  vec2 displaced=center+vec2(drift*3./grid.x,0.);
  vec3 sampleColor=imageAt(displaced);float light=dot(sampleColor,vec3(.2126,.7152,.0722));
  float rank=clamp((light+signal*.18)*float(glyphCount-1.)+.65*sin(clock*.17+dot(center,vec2(17.,11.)))+drift*3.,0.,glyphCount-1.001);
  float first=floor(rank),ink=mix(textureGrad(glyphMap,vec3(local,first),dx,dy).r,textureGrad(glyphMap,vec3(local,min(first+1.,glyphCount-1.)),dx,dy).r,smoothstep(0.,1.,fract(rank)));
  float ghost=textureGrad(glyphMap,vec3(fract(local+vec2(.19,0.)),mod(first+5.,glyphCount)),dx,dy).r;
  ink=mix(ink,max(ink*.7,ghost*.48),corruption*.45*(.5+.5*sin(clock*.24+cell.y*.03)));
  ink*=1.-corruption*.35*smoothstep(.87,.99,hash(cell));
  vec3 hue=imageHue(sampleColor,vec3(.4,.6,.55));
  vec3 ground=max(mix(base,sampleColor,.45)*.92,hue*.11);
  float inkLight=mix(.85,.25,smoothstep(.12,.8,light));
  return mix(ground,hueLuminance(hue,inkLight*(1.+signal*.16)),ink*.94);
}
float folded(vec2 q){
  float orbit=10.;q*=.72;
  for(int i=0;i<4;i++){q=abs(q)/max(dot(q,q),.36)-vec2(.92,.81);q=mat2(.86,-.51,.51,.86)*q;orbit=min(orbit,abs(length(q)-.86));}
  return exp(-orbit*22.);
}
void main(){
  vec2 uv=sceneUV(world),deformed=uv;
  if(surface>1.5&&surface<2.5){
    deformed+=vec2(sin(vUV.y*.38+time*.22),cos(vUV.x*12.-time*.19))*(.0015+.003*corruption);
  }
  vec3 base=imageAt(deformed),hue=imageHue(base,vec3(.4,.6,.55));
  vec3 c=mix(base,woven(deformed,base),hex);
  if(surface>.5&&surface<1.5){
    vec2 coord=vec2((vUV.x-.5)*5.,vUV.y),d=abs(fract(coord-.5)-.5)/max(fwidth(coord),vec2(.0001));
    float line=1.-min(min(d.x,d.y),1.);
    vec3 neg=imageVibrance(vec3(1.)-base,1.35);
    c=mix(base,neg,inversion)*.42+vec3(.06);
    float rail=smoothstep(.40,.415,abs(vUV.x-.5));
    c=mix(c,hueLuminance(imageHue(mix(base,neg,inversion),hue),.65),max(line*.40,rail*.75));
    color=vec4(c,1.);return;
  }
  float distanceFade=1.-smoothstep(36.,62.,distance(world,eye));
  if(surface>1.5&&surface<2.5){
    float contour=pow(.5+.5*sin(vUV.y*1.2+vUV.x*22.+sin(vUV.y*.17-time*.21)*2.),16.);
    float structure=folded(vec2((vUV.x-.5)*4.,vUV.y*.065));
    float wovenSeam=pow(.5+.5*cos(vUV.x*6.2831853),22.);
    c=mix(c,hueLuminance(hue,.78),contour*.18+structure*fractal*.34+wovenSeam*.08);
    float veil=warp*(.18+.18*sin(vUV.y*.5-time*1.4));
    c=mix(c,hueLuminance(hue,.7),veil);
    color=vec4(c,(opacity+contour*.10)*distanceFade);return;
  }
  if(surface>2.5){
    float rim=pow(1.-abs(vUV.x),2.);
    vec3 edge=hueLuminance(hue,.84);
    if(style<.5)c=mix(base*1.16,edge,rim*.40);
    else if(style<1.5)c=mix(woven(uv,base)*(.76+.12*abs(vUV.x)),hueLuminance(hue,min(.95,dot(base,vec3(.2126,.7152,.0722))+.28)),rim*.30);
    else if(style<2.5)c=mix(c,edge,rim*.35)*(.96+.04*sin(time*.6+vUV.y));
    else if(style<3.5)c=mix(base*.88,edge,rim*.25);
    else if(style<4.5)c=mix(c,edge,.25);
    else c=edge*(.7+.3*abs(vUV.x));
    color=vec4(c,archAlpha*distanceFade*(style>3.5&&style<4.5?.64:1.));return;
  }
  float structure=folded((uv-vec2(.5))*vec2(8.,4.));
  c=mix(c,hueLuminance(hue,.8),structure*fractal*.12);
  color=vec4(c,1.);
}`;

export function createDreamTunnelRenderer(canvas) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error("WebGL2 is required for the tunnel experiment.");
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, tunnelVertex],
    [gl.FRAGMENT_SHADER, tunnelFragment],
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
  const names = [
    "view",
    "projection",
    "eye",
    "archCenter",
    "archRight",
    "grid",
    "time",
    "blend",
    "neon",
    "hex",
    "corruption",
    "fractal",
    "surface",
    "style",
    "opacity",
    "inversion",
    "warp",
    "glyphCount",
    "archAlpha",
    "naturalA",
    "neonA",
    "naturalB",
    "neonB",
    "glyphMap",
  ];
  const u = Object.fromEntries(
    names.map((n) => [n, gl.getUniformLocation(program, n)]),
  );
  const camera = new DomeCamera(),
    meshes = new Set(),
    textures = Array.from({ length: 5 }, () => gl.createTexture());
  let segments = [],
    origin = -1,
    uploadKey = "",
    glyphs = [];
  const settings = {
    opacity: 0.54,
    inversion: 0.65,
    yaw: 0,
    pitch: 0,
    archStyle: -1,
    corruption: 1,
  };
  function mesh(data) {
    const vao = gl.createVertexArray(),
      vb = gl.createBuffer(),
      ib = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
    const m = {
      vao,
      vb,
      ib,
      count: data.indices.length,
      ...(data.frame ? { frame: data.frame, style: data.style } : {}),
    };
    meshes.add(m);
    return m;
  }
  function remove(m) {
    gl.deleteBuffer(m.vb);
    gl.deleteBuffer(m.ib);
    gl.deleteVertexArray(m.vao);
    meshes.delete(m);
  }
  const sphere = mesh(createDomeMesh(64));
  const atlas = document.createElement("canvas");
  atlas.width = 32;
  atlas.height = 48;
  const ctx = atlas.getContext("2d");
  glyphs = [...GLYPH_SETS.hex]
    .map((character) => {
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
          const v = rgba[((47 - y) * 32 + x) * 4];
          red[y * 32 + x] = v;
          coverage += v;
        }
      return { character, red, coverage };
    })
    .sort((a, b) => a.coverage - b.coverage);
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
  function upload(index, image) {
    gl.activeTexture(gl.TEXTURE0 + index);
    gl.bindTexture(gl.TEXTURE_2D, textures[index]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
  }
  function images(a, b, key) {
    if (key === uploadKey) return;
    [a.natural, a.neon, b.natural, b.neon].forEach((image, i) =>
      upload(i, image),
    );
    uploadKey = key;
  }
  function rebuild(node) {
    for (const s of segments) {
      remove(s.wall);
      remove(s.floor);
      s.arches.forEach(remove);
    }
    segments = [];
    origin = node;
    for (let n = Math.max(-1, node - 2); n <= node + 4; n++) {
      const style =
          settings.archStyle < 0 ? (((n + 1) % 6) + 6) % 6 : settings.archStyle,
        arches = [];
      const fractions = style === 2 ? [0.35, 0.45, 0.55, 0.65, 0.75] : [0.56];
      for (const f of fractions)
        arches.push(mesh(createTunnelArch(n + f, origin, style)));
      // Nested echoes are already resident and become visible only at depth.
      if (style !== 2)
        for (const f of [0.7, 0.83]) {
          const a = mesh(createTunnelArch(n + f, origin, style));
          a.echo = true;
          arches.push(a);
        }
      segments.push({
        n,
        style,
        wall: mesh(createTunnelStrip(n, n + 1, origin)),
        floor: mesh(createTunnelStrip(n, n + 1, origin, { floor: true })),
        arches,
      });
    }
  }
  function drawMesh(m) {
    gl.bindVertexArray(m.vao);
    gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
  }
  function draw(state, time = 0) {
    if (!uploadKey) return;
    if (
      origin !== state.node ||
      segments[0]?.forcedStyle !== settings.archStyle
    ) {
      rebuild(state.node);
      segments[0].forcedStyle = settings.archStyle;
    }
    const frame = tunnelFrame(state.parameter, origin),
      eye = [
        frame.position[0] + frame.right[0] * state.lateral,
        0,
        frame.position[1] + frame.right[1] * state.lateral,
      ];
    camera.target = eye;
    camera.dolly = 0;
    camera.yaw = frame.yaw + settings.yaw;
    camera.pitch = settings.pitch;
    const { view, projection } = camera.matrices(canvas.width / canvas.height);
    const near = 0.05,
      far = 120;
    projection[10] = (far + near) / (near - far);
    projection[14] = (2 * far * near) / (near - far);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.clearColor(0.02, 0.025, 0.04, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    textures.forEach((t, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(i === 4 ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D, t);
    });
    ["naturalA", "neonA", "naturalB", "neonB", "glyphMap"].forEach((n, i) =>
      gl.uniform1i(u[n], i),
    );
    gl.uniformMatrix4fv(u.view, false, view);
    gl.uniformMatrix4fv(u.projection, false, projection);
    gl.uniform3fv(u.eye, eye);
    gl.uniform2f(u.grid, 416, 144);
    const p = state.profile;
    for (const [n, v] of Object.entries({
      time,
      blend: state.handoff,
      neon: p.neon,
      hex: p.hex,
      corruption: p.corruption * settings.corruption,
      fractal: p.fractal,
      opacity: settings.opacity,
      inversion: settings.inversion,
      warp: state.warp,
      glyphCount: glyphs.length,
    }))
      gl.uniform1f(u[n], v);
    gl.uniform1f(u.surface, 0);
    drawMesh(sphere);
    gl.uniform1f(u.surface, 1);
    for (const s of segments) drawMesh(s.floor);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(u.surface, 3);
    gl.uniform1f(u.archAlpha, 1);
    for (const s of segments)
      for (const a of s.arches) {
        if (a.echo && p.echo < 0.001) continue;
        gl.uniform1f(u.archAlpha, a.echo ? p.echo * 0.38 : 1);
        gl.uniform1f(u.style, a.style);
        gl.uniform3f(u.archCenter, a.frame.position[0], 0, a.frame.position[1]);
        gl.uniform2fv(u.archRight, a.frame.right);
        gl.depthMask(!a.echo && a.style !== 4);
        drawMesh(a);
      }
    gl.depthMask(false);
    gl.uniform1f(u.surface, 2);
    const ordered = [...segments].sort(
      (a, b) =>
        Math.abs(b.n - state.parameter) - Math.abs(a.n - state.parameter),
    );
    for (const s of ordered) drawMesh(s.wall);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
  return {
    draw,
    images,
    settings,
    gl,
    camera,
    get glyphs() {
      return glyphs.map((g) => g.character).join("");
    },
    get stats() {
      return {
        meshes: meshes.size,
        textures: textures.length,
        segments: segments.length,
        origin,
        originSite: tunnelSite(origin),
      };
    },
    pixels() {
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
    },
    dispose() {
      for (const m of meshes) remove(m);
      textures.forEach((t) => gl.deleteTexture(t));
      gl.deleteProgram(program);
    },
  };
}
