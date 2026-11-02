// Diagnose direct canvas-surface uploads, not the safe ImageData photo uploads.
// A larger source exercises paths that a software-backed 1px canvas can miss.
// The output attachment uses raw storage, not another canvas upload.
export function probeCanvasRedBlue(gl) {
  const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
  gl.activeTexture(gl.TEXTURE0);
  const saved = {
    texture: gl.getParameter(gl.TEXTURE_BINDING_2D),
    draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
    read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
    program: gl.getParameter(gl.CURRENT_PROGRAM),
    vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    viewport: gl.getParameter(gl.VIEWPORT),
    mask: gl.getParameter(gl.COLOR_WRITEMASK),
    flip: gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL),
    pack: gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING),
    unpack: gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING),
  };
  const flags = [
    gl.BLEND,
    gl.DEPTH_TEST,
    gl.CULL_FACE,
    gl.SCISSOR_TEST,
    gl.DITHER,
  ];
  const enabled = flags.map((flag) => gl.isEnabled(flag));
  const input = gl.createTexture(),
    output = gl.createTexture();
  const framebuffer = gl.createFramebuffer(),
    vao = gl.createVertexArray();
  const program = gl.createProgram(),
    shaders = [];
  try {
    for (const [type, source] of [
      [
        gl.VERTEX_SHADER,
        `#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0.0,1.0);}`,
      ],
      [
        gl.FRAGMENT_SHADER,
        `#version 300 es
precision highp float;
uniform sampler2D u_probe; out vec4 color;
void main(){color=texture(u_probe,vec2(0.5));}`,
      ],
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
    const canvas =
      typeof document !== "undefined"
        ? document.createElement("canvas")
        : new OffscreenCanvas(64, 64);
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 64, 64);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.bindTexture(gl.TEXTURE_2D, input);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.bindTexture(gl.TEXTURE_2D, output);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      output,
      0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error("Canvas color probe framebuffer is incomplete.");
    for (const flag of flags) gl.disable(flag);
    gl.colorMask(true, true, true, true);
    gl.viewport(0, 0, 1, 1);
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.bindTexture(gl.TEXTURE_2D, input);
    gl.uniform1i(gl.getUniformLocation(program, "u_probe"), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return {
      swapRB: pixel[0] < 128 && pixel[2] > 128 ? 1 : 0,
      pixel: Array.from(pixel),
    };
  } finally {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, saved.draw);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, saved.read);
    gl.useProgram(saved.program);
    gl.bindVertexArray(saved.vao);
    gl.viewport(...saved.viewport);
    gl.colorMask(...saved.mask);
    flags.forEach((flag, i) =>
      enabled[i] ? gl.enable(flag) : gl.disable(flag),
    );
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, saved.flip);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, saved.pack);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, saved.unpack);
    gl.bindTexture(gl.TEXTURE_2D, saved.texture);
    gl.activeTexture(activeTexture);
    gl.deleteTexture(input);
    gl.deleteTexture(output);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
  }
}
