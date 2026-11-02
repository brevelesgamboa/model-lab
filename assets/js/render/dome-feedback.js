// The previous view is copied before drawing the next view. It is never sampled
// from an attached render target, and repeated paused renders do not accumulate.
export function prepareDomeFeedback(gl, graphics, frame) {
  const state = (graphics.feedback ??= {
    width: 0,
    height: 0,
    previous: null,
    valid: false,
    motion: [0, 0],
  });
  gl.activeTexture(gl.TEXTURE12);
  gl.bindTexture(gl.TEXTURE_2D, graphics.textures[12]);
  const resized = state.width !== frame.width || state.height !== frame.height;
  if (resized) {
    // The dome has an opaque RGB drawing buffer. RGBA copies are invalid on ANGLE.
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGB8,
      frame.width,
      frame.height,
      0,
      gl.RGB,
      gl.UNSIGNED_BYTE,
      null,
    );
    state.width = frame.width;
    state.height = frame.height;
    state.valid = false;
  }
  const previous = state.previous;
  if (!previous || previous.signature !== frame.signature) {
    const turn = previous
      ? Math.atan2(
          Math.sin(frame.yaw - previous.yaw),
          Math.cos(frame.yaw - previous.yaw),
        )
      : 0;
    const dx = previous ? frame.position[0] - previous.position[0] : 0;
    const dz = previous ? frame.position[1] - previous.position[1] : 0;
    state.valid = Boolean(
      !resized &&
      previous &&
      frame.active &&
      previous.active &&
      frame.epoch === previous.epoch &&
      Math.hypot(dx, dz) < 2.8 &&
      Math.abs(turn) < 0.45 &&
      Math.abs(frame.pitch - previous.pitch) < 0.45 &&
      Math.abs(frame.time - previous.time) < 0.35,
    );
    if (state.valid)
      gl.copyTexSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        0,
        0,
        frame.width,
        frame.height,
      );
    state.motion = [
      turn * 0.35 +
        (dx * Math.cos(frame.yaw) + dz * Math.sin(frame.yaw)) * 0.018,
      (frame.pitch - (previous?.pitch ?? frame.pitch)) * 0.35 -
        (dx * Math.sin(frame.yaw) - dz * Math.cos(frame.yaw)) * 0.008,
    ];
  }
  state.previous = frame;
  return state;
}
