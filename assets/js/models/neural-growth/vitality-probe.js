export const PROBE_SIZE = 32;
export const SNAPSHOT_SIZE = PROBE_SIZE * 2;
export const METRIC_PLANES = 9;
export const ELIGIBLE_TILE_MINIMUM = Math.round((255 * 3) / 4);
const WIDTH = PROBE_SIZE * METRIC_PLANES;
const BYTE_LENGTH = WIDTH * PROBE_SIZE * 4;

// Exact byte sums plus directly encoded local deviations avoid phantom variance.
// Weighted Welford merging retains both within-tile and between-tile contrast.
export function decodeVitalityProbe(bytes, metadata) {
  const sums = new Float64Array(18);
  const eligible = new Uint8Array(PROBE_SIZE * PROBE_SIZE);
  const means = [new Float64Array(3), new Float64Array(3)];
  const moments = [0, 0];
  let coverage = 0,
    seedTile = null,
    seedContrast = -1;
  const metric = (x, y, index) => {
    const offset =
      (y * WIDTH + Math.floor(index / 2) * PROBE_SIZE + x) * 4 +
      (index % 2) * 2;
    return (bytes[offset] * 256 + bytes[offset + 1]) / 65535;
  };
  for (let y = 0; y < PROBE_SIZE; y++)
    for (let x = 0; x < PROBE_SIZE; x++) {
      const count = Math.round(metric(x, y, 11) * 4);
      eligible[y * PROBE_SIZE + x] = Math.round((count / 4) * 255);
      if (!count) continue;
      const nextCoverage = coverage + count;
      if (count >= 3 && metric(x, y, 7) > seedContrast) {
        seedContrast = metric(x, y, 7);
        seedTile = y * PROBE_SIZE + x;
      }
      for (let group = 0; group < 2; group++) {
        const scale = group === 0 ? 1020 : 2040;
        const unit = group === 0 ? 255 : 510;
        for (let ch = 0; ch < 3; ch++) {
          const mean =
            Math.round(metric(x, y, group * 4 + ch) * scale) / (count * unit);
          const delta = mean - means[group][ch];
          moments[group] +=
            (delta * delta * coverage * count) / nextCoverage / 3;
          means[group][ch] += (delta * count) / nextCoverage;
        }
        moments[group] += (metric(x, y, group * 4 + 3) / 2) ** 2 * count;
      }
      coverage = nextCoverage;
      for (let index = 8; index < sums.length; index++)
        sums[index] += metric(x, y, index) * count;
    }
  if (coverage > 0)
    for (let index = 8; index < sums.length; index++) sums[index] /= coverage;
  return Object.freeze({
    ...metadata,
    rgbContrast: coverage ? Math.sqrt(moments[0] / coverage) : 0,
    nativeContrast: coverage ? Math.sqrt(moments[1] / coverage) : 0,
    nativeBrightness: (means[1][0] + means[1][1] + means[1][2]) / 3,
    hiddenEnergy: sums[8],
    hiddenDelta: metadata.hasHistory ? sums[9] : null,
    clipping: sums[10],
    coverage: coverage / (eligible.length * 4),
    rgbEnergy: sums[12],
    rgbDelta: metadata.hasHistory ? sums[13] : null,
    rgbClipping: sums[14],
    nativeBlackCoverage: sums[15],
    nativeWhiteCoverage: sums[16],
    nativeDelta: metadata.hasHistory ? sums[17] : null,
    eligible,
    seedTile,
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
    this.latestDiagnostic = null;
    this.forceRequest = null;
    this.requestSequence = 0;
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
    this.latestDiagnostic = null;
    this.forceRequest = null;
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
        if (result.forced) this.latestDiagnostic = result;
        else if (!this.latest || result.steps > this.latest.steps)
          this.latest = result;
      }
      gl.deleteSync(slot.sync);
      slot.sync = null;
      slot.metadata = null;
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  }
  requestProbe(generation) {
    if (this.disposed || this.unavailable || this.forcePending) return null;
    if (this.generation !== generation) this.invalidate(generation);
    this.forceRequest = ++this.requestSequence;
    return this.forceRequest;
  }
  get forcePending() {
    return (
      this.forceRequest !== null ||
      this.slots.some((slot) => slot.sync && slot.metadata?.forced)
    );
  }
  update(
    timestamp,
    { generation, steps, activeSeconds = 0, pollOnly = false },
  ) {
    if (this.disposed || this.unavailable) return null;
    try {
      if (this.generation !== generation) this.invalidate(generation);
      if (steps < this.lastSteps) this.lastSteps = 0;
      if (!this.target) this.initialize();
      this.poll(timestamp, generation);
      const interval = this.size <= 256 ? 500 : 1000;
      const forced = this.forceRequest !== null;
      if (
        !forced &&
        (pollOnly ||
          steps <= this.lastSteps ||
          timestamp - this.lastLaunch < interval)
      )
        return this.latest;
      const slot = this.slots.find((entry) => !entry.sync);
      if (!slot) return this.latest;
      this.render(this.target, this.history, this.hasHistory);
      const gl = this.gl;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
      gl.readPixels(0, 0, WIDTH, PROBE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      // Debug samples must not alter production history, cadence, or evidence.
      if (!forced) this.capture(this.history);
      slot.metadata = {
        generation,
        steps,
        activeSeconds,
        timestamp,
        hasHistory: this.hasHistory,
        size: this.size,
        forced,
        requestId: forced ? this.forceRequest : null,
      };
      slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!slot.sync) throw new Error("Could not fence vitality readback.");
      gl.flush();
      if (forced) this.forceRequest = null;
      else {
        this.hasHistory = true;
        this.lastLaunch = timestamp;
        this.lastSteps = steps;
      }
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
