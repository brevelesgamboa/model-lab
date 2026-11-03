// Reuses the real model, mesh, shader assembly, uniforms and rendering path.
// The isolated study keeps the original program alongside opt-in extensions.
import { CorticalDreamDomeModel } from "../assets/js/models/cortical-dream-dome.js";
import { luminanceDepth } from "../assets/js/models/depth-estimator.js";
import { emptyFeatureMap } from "../assets/js/models/inception-feature-map.js";
import { extendOriginShader } from "./dream-origin-shaders.mjs";
import { originTreatment } from "./dream-origin-space.mjs";

export async function createOriginRenderer(canvas, { extended = true } = {}) {
  const model = new CorticalDreamDomeModel(),
    gl = model.gl;
  if (!gl) throw new Error("This study requires WebGL2.");
  const params = Object.fromEntries(
    model.controls.map((c) => [c.key, c.default]),
  );
  const settings = {
    floor: 0.72,
    negative: 0.55,
    portal: true,
    fullHex: false,
    digital: true,
  };
  let extra = null,
    baseImage = null,
    nextImage = null;
  function compile(g) {
    // Attached shaders remain alive after deleteShader until their program is
    // deleted. Read exactly what the app factory assembled, including includes.
    const original = gl.getAttachedShaders(g.program).map((shader) => ({
      type: gl.getShaderParameter(shader, gl.SHADER_TYPE),
      source: gl.getShaderSource(shader),
    }));
    if (original.length !== 2 || original.some((s) => !s.source))
      throw new Error("Could not inspect the original dome shaders.");
    const program = gl.createProgram();
    for (const { type, source } of original) {
      const shader = gl.createShader(type);
      gl.shaderSource(
        shader,
        extendOriginShader(source, type === gl.FRAGMENT_SHADER),
      );
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program));
    const originalProgram = g.program,
      originalUniforms = g.uniforms;
    const extendedUniforms = {};
    for (const name of Object.keys(originalUniforms))
      extendedUniforms[name] = gl.getUniformLocation(
        program,
        `u_${name === "journey_room_cells" ? "journey_room_cells[0]" : name}`,
      );
    const names = [
      "explore",
      "position",
      "next",
      "glyphs",
      "mix",
      "neon",
      "hex",
      "corruption",
      "floor",
      "negative",
      "portal_on",
      "portal_yaw",
      "portal",
      "warp",
      "glyph_count",
    ];
    const u = Object.fromEntries(
      names.map((name) => [
        name,
        gl.getUniformLocation(program, "u_origin_" + name),
      ]),
    );
    const next = gl.createTexture(),
      glyph = gl.createTexture(),
      atlas = document.createElement("canvas");
    atlas.width = 32;
    atlas.height = 48;
    const ctx = atlas.getContext("2d");
    const glyphs = [..." 0123456789ABCDEF"]
      .map((character) => {
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, 32, 48);
        ctx.fillStyle = "white";
        ctx.font = "bold 40px monospace";
        ctx.textAlign = "center";
        ctx.fillText(character, 16, 38);
        const data = ctx.getImageData(0, 0, 32, 48).data,
          red = new Uint8Array(1536);
        let coverage = 0;
        for (let y = 0; y < 48; y++)
          for (let x = 0; x < 32; x++) {
            const v = data[((47 - y) * 32 + x) * 4];
            red[y * 32 + x] = v;
            coverage += v;
          }
        return { character, red, coverage };
      })
      .sort((a, b) => a.coverage - b.coverage);
    gl.activeTexture(gl.TEXTURE14);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, glyph);
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
    return {
      graphics: g,
      originalProgram,
      originalUniforms,
      extendedUniforms,
      program,
      u,
      next,
      glyph,
      glyphs: glyphs.map((g) => g.character).join(""),
    };
  }
  async function ensure() {
    const g = await model.ensureGraphics();
    if (extended && extra?.graphics !== g) {
      extra = compile(g);
      baseImage = null;
      nextImage = null;
    }
    return g;
  }
  function uploadNext(image) {
    gl.activeTexture(gl.TEXTURE13);
    gl.bindTexture(gl.TEXTURE_2D, extra.next);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
  }
  async function source(
    image = null,
    { name = "Built-in landscape", features = true } = {},
  ) {
    if (!image) model.useDemo();
    else {
      model.cancel();
      const w = image.naturalWidth || image.width,
        h = image.naturalHeight || image.height,
        scale = Math.min(1, 2048 / Math.max(w, h));
      model.source.width = Math.round(w * scale);
      model.source.height = Math.round(h * scale);
      model.source
        .getContext("2d")
        .drawImage(image, 0, 0, model.source.width, model.source.height);
      model.hasPhoto = true;
      model.sourceName = name;
      model.seedSources = null;
      model.depthMap = luminanceDepth(model.source);
      model.featureMap = emptyFeatureMap();
      model.depthState = "fallback";
      model.depthStatus = "Brightness relief · optional estimated depth";
      model.featureState = "pending";
      model.prepareSurround();
      model.uploadSource();
    }
    await ensure();
    baseImage = null;
    nextImage = null;
    model.camera.reset();
    if (image && features)
      await model.buildMaps({ depth: false, feature: true });
    return model.mirrorSeed;
  }
  async function draw({
    space,
    base,
    next = base,
    mix = 0,
    depth = 0,
    time = 0,
    warp = 0,
    original = false,
    portalPresence = 1,
    target = canvas,
  } = {}) {
    const g = await ensure();
    const treatment = originTreatment(original ? 0 : depth);
    const neon = !original && settings.digital ? treatment.neon : 0;
    const hex = original
      ? 0
      : settings.fullHex
        ? 1
        : settings.digital
          ? treatment.hex
          : 0;
    const useOriginal = !space?.enabled && mix === 0 && neon === 0 && hex === 0;
    if (extra) {
      g.program = useOriginal ? extra.originalProgram : extra.program;
      g.uniforms = useOriginal
        ? extra.originalUniforms
        : extra.extendedUniforms;
    }
    if (base && base !== baseImage) {
      model.panorama = base;
      model.uploadSource();
      baseImage = base;
    }
    model.journey.enabled = false;
    model.camera.yaw = space?.yaw || 0;
    model.camera.pitch = space?.pitch || 0;
    model.camera.target = space?.parallax || [0, 0, 0];
    if (extra && !useOriginal) {
      if (next !== nextImage) {
        uploadNext(next || model.panorama);
        nextImage = next;
      }
      const t = treatment,
        u = extra.u;
      gl.useProgram(g.program);
      gl.activeTexture(gl.TEXTURE13);
      gl.bindTexture(gl.TEXTURE_2D, extra.next);
      gl.uniform1i(u.next, 13);
      gl.activeTexture(gl.TEXTURE14);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, extra.glyph);
      gl.uniform1i(u.glyphs, 14);
      gl.uniform1f(u.mix, mix);
      gl.uniform1f(u.explore, space?.enabled ? 1 : 0);
      gl.uniform2fv(u.position, space?.position || [0, 0]);
      gl.uniform2fv(u.portal, space?.portal || [0, -12]);
      for (const [name, value] of Object.entries({
        neon,
        hex,
        corruption: t.corruption,
        floor: settings.floor,
        negative: settings.negative,
        portal_on: settings.portal ? portalPresence : 0,
        portal_yaw: space?.portalYaw || 0,
        warp,
        glyph_count: 17,
      }))
        gl.uniform1f(u[name], value);
    }
    await model.render(target, params, time);
    return {
      glError: gl.getError(),
      vertices: 65536,
      textures: extended ? 15 : 13,
      source: model.sourceName,
      depth: model.depthMap.kind,
      feature: model.featureMap.kind,
    };
  }
  function pixels() {
    const bytes = new Uint8Array(model.canvas.width * model.canvas.height * 4);
    gl.readPixels(
      0,
      0,
      model.canvas.width,
      model.canvas.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      bytes,
    );
    return bytes;
  }
  await ensure();
  return {
    model,
    gl,
    params,
    settings,
    source,
    draw,
    pixels,
    get glyphs() {
      return extra?.glyphs || "";
    },
    dispose() {
      if (extra) {
        gl.deleteTexture(extra.next);
        gl.deleteTexture(extra.glyph);
        gl.deleteProgram(
          model.graphics?.program === extra.program
            ? extra.originalProgram
            : extra.program,
        );
      }
      model.dispose();
    },
  };
}
