export const PROBE_SIZE = 32;
export const SNAPSHOT_SIZE = PROBE_SIZE * 2;
export const METRIC_PLANES = 6;
const WIDTH = PROBE_SIZE * METRIC_PLANES;
const BYTE_LENGTH = WIDTH * PROBE_SIZE * 4;

// Each tile carries twelve 16-bit statistics. Moments and nonlinear metrics
// were computed from individual eligible cells on the GPU, before averaging.
export function decodeVitalityProbe(bytes, metadata) {
  const sums = new Float64Array(12);
  const eligible = new Uint8Array(PROBE_SIZE * PROBE_SIZE);
  let coverage = 0;
  const metric = (x, y, index) => {
    const offset =
      (y * WIDTH + Math.floor(index / 2) * PROBE_SIZE + x) * 4 +
      (index % 2) * 2;
    return (bytes[offset] * 256 + bytes[offset + 1]) / 65535;
  };
  for (let y = 0; y < PROBE_SIZE; y++)
    for (let x = 0; x < PROBE_SIZE; x++) {
      const weight = metric(x, y, 9);
      eligible[y * PROBE_SIZE + x] = Math.round(weight * 255);
      coverage += weight;
      for (let index = 0; index < sums.length; index++)
        sums[index] += metric(x, y, index) * weight;
    }
  if (coverage > 0)
    for (let index = 0; index < sums.length; index++) sums[index] /= coverage;
  const variance =
    (sums[3] - sums[0] ** 2 + sums[4] - sums[1] ** 2 + sums[5] - sums[2] ** 2) /
    3;
  return Object.freeze({
    ...metadata,
    rgbContrast: Math.sqrt(Math.max(0, variance)),
    hiddenEnergy: sums[6],
    hiddenDelta: metadata.hasHistory ? sums[7] : null,
    clipping: sums[8],
    coverage: coverage / eligible.length,
    rgbEnergy: sums[10],
    rgbDelta: metadata.hasHistory ? sums[11] : null,
    eligible,
  });
}

export class GpuVitalityProbe {
  static supported(gl) {
    return (
      [
        "createBuffer",
        "bindBuffer",
        "bufferData",
        "readPixels",
        "fenceSync",
        "clientWaitSync",
        "getBufferSubData",
        "deleteSync",
        "deleteBuffer",
        "flush",
      ].every((key) => typeof gl?.[key] === "function") &&
      gl.PIXEL_PACK_BUFFER !== undefined
    );
  }
  constructor({ gl, size, allocate, render, capture }) {
    this.gl = gl;
    this.size = size;
    this.allocate = allocate;
    this.render = render;
    this.capture = capture;
    this.slots = [];
    this.latest = null;
    this.generation = null;
    this.lastLaunch = -Infinity;
    this.lastSteps = 0;
    this.hasHistory = false;
    this.unavailable = !GpuVitalityProbe.supported(gl);
    this.disposed = false;
  }
  initialize() {
    const gl = this.gl;
    this.target = this.allocate(WIDTH, PROBE_SIZE, true);
    this.history = this.allocate(SNAPSHOT_SIZE * 3, SNAPSHOT_SIZE, true);
    for (let index = 0; index < 2; index++) {
      const buffer = gl.createBuffer();
      if (!buffer)
        throw new Error("Could not allocate vitality readback buffer.");
      this.slots.push({
        buffer,
        sync: null,
        bytes: new Uint8Array(BYTE_LENGTH),
        metadata: null,
      });
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, BYTE_LENGTH, gl.STREAM_READ);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  }
  invalidate(generation) {
    this.generation = generation;
    this.latest = null;
    this.hasHistory = false;
    for (const slot of this.slots) {
      if (slot.sync) this.gl.deleteSync(slot.sync);
      slot.sync = null;
      slot.metadata = null;
    }
  }
  poll(timestamp, generation) {
    const gl = this.gl;
    for (const slot of this.slots) {
      if (!slot.sync || timestamp <= slot.metadata.timestamp) continue;
      const state = gl.clientWaitSync(slot.sync, 0, 0);
      if (state === gl.WAIT_FAILED) throw new Error("Vitality fence failed.");
      if (state !== gl.ALREADY_SIGNALED && state !== gl.CONDITION_SATISFIED)
        continue;
      // Never request CPU bytes until a fence signals on a subsequent frame.
      // https://registry.khronos.org/webgl/specs/latest/2.0/#3.7.3
      if (slot.metadata.generation === generation) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, slot.bytes);
        const result = decodeVitalityProbe(slot.bytes, slot.metadata);
        if (!this.latest || result.steps > this.latest.steps)
          this.latest = result;
      }
      gl.deleteSync(slot.sync);
      slot.sync = null;
      slot.metadata = null;
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  }
  update(timestamp, { generation, steps, activeSeconds = 0 }) {
    if (this.disposed || this.unavailable) return null;
    try {
      if (this.generation !== generation) this.invalidate(generation);
      if (steps < this.lastSteps) this.lastSteps = 0;
      if (!this.target) this.initialize();
      this.poll(timestamp, generation);
      const interval = this.size <= 256 ? 500 : 1000;
      if (steps <= this.lastSteps || timestamp - this.lastLaunch < interval)
        return this.latest;
      const slot = this.slots.find((entry) => !entry.sync);
      if (!slot) return this.latest;
      this.render(this.target, this.history, this.hasHistory);
      const gl = this.gl;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
      gl.readPixels(0, 0, WIDTH, PROBE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.capture(this.history);
      slot.metadata = {
        generation,
        steps,
        activeSeconds,
        timestamp,
        hasHistory: this.hasHistory,
        size: this.size,
      };
      slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!slot.sync) throw new Error("Could not fence vitality readback.");
      gl.flush();
      this.hasHistory = true;
      this.lastLaunch = timestamp;
      this.lastSteps = steps;
    } catch (error) {
      this.error = error;
      this.unavailable = true;
      this.dispose();
    }
    return this.latest;
  }
  dispose() {
    if (this.disposed) return;
    this.invalidate(this.generation);
    this.disposed = true;
    for (const slot of this.slots) this.gl.deleteBuffer(slot.buffer);
    this.slots.length = 0;
    if (GpuVitalityProbe.supported(this.gl))
      this.gl.bindBuffer(this.gl.PIXEL_PACK_BUFFER, null);
    // Targets are owned by the runtime's texture/framebuffer resource lists.
  }
}
