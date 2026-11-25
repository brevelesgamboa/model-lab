import test from "node:test";
import assert from "node:assert/strict";
import {
  GpuVitalityProbe,
  decodeVitalityProbe,
  PROBE_SIZE,
  METRIC_PLANES,
} from "../../assets/js/models/neural-growth/vitality-probe.js";
import { TextureNcaRuntime } from "../../assets/js/models/neural-growth/runtime.js";

function encoded(
  metrics = [0.5, 0.5, 0.5, 0.26, 0.26, 0.26, 0.2, 0.03, 0, 1, 0.1, 0.02],
) {
  const width = PROBE_SIZE * METRIC_PLANES,
    bytes = new Uint8Array(width * PROBE_SIZE * 4);
  for (let y = 0; y < PROBE_SIZE; y++)
    for (let x = 0; x < PROBE_SIZE; x++)
      for (let m = 0; m < metrics.length; m++) {
        const offset =
          (y * width + Math.floor(m / 2) * PROBE_SIZE + x) * 4 + (m % 2) * 2;
        const bits = Math.round(metrics[m] * 65535);
        bytes[offset] = bits >> 8;
        bytes[offset + 1] = bits & 255;
      }
  return bytes;
}
function setup(size = 256) {
  const calls = {
    reads: [],
    copies: 0,
    waits: [],
    deletedBuffers: [],
    deletedSyncs: [],
    renders: 0,
    targets: [],
  };
  let binding = null,
    index = 0;
  const states = new Map();
  const gl = {
    PIXEL_PACK_BUFFER: 1,
    STREAM_READ: 2,
    RGBA: 3,
    UNSIGNED_BYTE: 4,
    SYNC_GPU_COMMANDS_COMPLETE: 5,
    TIMEOUT_EXPIRED: 6,
    ALREADY_SIGNALED: 7,
    CONDITION_SATISFIED: 8,
    WAIT_FAILED: 9,
    createBuffer: () => ({ id: ++index }),
    bindBuffer: (_target, buffer) => {
      binding = buffer;
    },
    bufferData() {},
    readPixels: (...args) => {
      assert.ok(binding);
      assert.equal(args.at(-1), 0);
      calls.reads.push(args);
    },
    fenceSync: () => {
      const sync = { id: ++index };
      states.set(sync, gl.TIMEOUT_EXPIRED);
      return sync;
    },
    clientWaitSync: (sync, flags, timeout) => {
      calls.waits.push([flags, timeout]);
      return states.get(sync);
    },
    getBufferSubData: (_target, _offset, bytes) => {
      assert.ok(binding);
      calls.copies++;
      bytes.set(encoded());
    },
    deleteBuffer: (buffer) => calls.deletedBuffers.push(buffer),
    deleteSync: (sync) => calls.deletedSyncs.push(sync),
    flush() {},
    isContextLost: () => false,
  };
  const probe = new GpuVitalityProbe({
    gl,
    size,
    allocate: (width, height) => {
      const target = { width, height, texture: {}, framebuffer: {} };
      calls.targets.push(target);
      return target;
    },
    render: () => calls.renders++,
    capture() {},
  });
  const update = (time, steps, generation = 1) =>
    probe.update(time, { steps, generation, activeSeconds: time / 1000 });
  const signal = () => {
    for (const sync of states.keys()) states.set(sync, gl.ALREADY_SIGNALED);
  };
  return { probe, gl, calls, states, update, signal };
}

test("GPU statistics preserve spatial second moments instead of contrasting averaged RGB", () => {
  const result = decodeVitalityProbe(encoded(), { hasHistory: true });
  assert.ok(Math.abs(result.rgbContrast - 0.1) < 0.0001);
  assert.ok(Math.abs(result.hiddenEnergy - 0.2) < 0.0001);
  assert.ok(Math.abs(result.hiddenDelta - 0.03) < 0.0001);
  assert.equal(result.coverage, 1);
  assert.ok(result.eligible.every((value) => value === 255));
  const protectedResult = decodeVitalityProbe(
    encoded([0.5, 0.5, 0.5, 0.25, 0.25, 0.25, 1, 1, 1, 0, 1, 1]),
    { hasHistory: true },
  );
  assert.equal(protectedResult.coverage, 0);
  assert.equal(protectedResult.hiddenEnergy, 0);
  assert.equal(protectedResult.clipping, 0);
});

test("two reusable PBO slots never wait or copy CPU bytes in their launch frame", () => {
  const { probe, calls, update, signal } = setup();
  update(0, 1);
  signal();
  update(0, 1);
  assert.equal(calls.copies, 0);
  assert.equal(calls.waits.length, 0);
  update(16, 1);
  assert.equal(calls.copies, 1);
  assert.equal(probe.latest.steps, 1);
  assert.equal(probe.latest.hiddenDelta, null);
  assert.equal(probe.slots.length, 2);
  update(500, 2);
  signal();
  update(516, 2);
  assert.ok(probe.latest.hiddenDelta > 0);
  assert.ok(
    calls.waits.every(([flags, timeout]) => flags === 0 && timeout === 0),
  );
  assert.equal(calls.targets.length, 2);
});

test("busy slots skip new probes, and polling alone never schedules without intervening steps", () => {
  const { calls, update, signal } = setup();
  update(0, 1);
  update(500, 2);
  update(1000, 3);
  update(1500, 4);
  assert.equal(calls.reads.length, 2);
  assert.equal(calls.copies, 0);
  signal();
  update(1600, 4);
  assert.equal(calls.copies, 2);
  assert.equal(calls.reads.length, 3);
  signal();
  update(2200, 4);
  update(3000, 4);
  assert.equal(calls.reads.length, 3);
});

test("probe cadence is 2Hz for 128/256 and 1Hz for 512/1024 grids", () => {
  for (const size of [128, 256, 512, 1024]) {
    const { calls, update, signal } = setup(size);
    for (let time = 0; time <= 2000; time += 100) {
      signal();
      update(time, time + 1);
    }
    assert.equal(calls.reads.length, size <= 256 ? 5 : 3);
  }
});

test("runtime generations discard pending probes and reset cached state/history", () => {
  const { probe, calls, update, signal } = setup();
  update(0, 1);
  update(500, 2);
  signal();
  update(600, 0, 2);
  assert.equal(calls.copies, 0);
  assert.equal(probe.latest, null);
  assert.equal(calls.deletedSyncs.length, 2);
  update(1000, 3, 2);
  signal();
  update(1016, 3, 2);
  assert.equal(probe.latest.generation, 2);
  assert.equal(probe.latest.hasHistory, false);
  probe.invalidate(3);
  assert.equal(probe.latest, null);
});

test("missing PBO/sync support disables monitoring with no synchronous fallback", () => {
  const runtime = Object.assign(Object.create(TextureNcaRuntime.prototype), {
    gl: {
      isContextLost: () => false,
      readPixels() {
        assert.fail("No synchronous readback fallback");
      },
    },
    steps: 100,
    size: 128,
    generation: 1,
  });
  assert.equal(runtime.monitorVitality(1000, 5), null);
  assert.equal(runtime.isDormant(), false);
});

test("cached isDormant reads no pixels and rejects protected/stale/context-lost results", () => {
  const runtime = Object.assign(Object.create(TextureNcaRuntime.prototype), {
    gl: {
      isContextLost: () => false,
      readPixels() {
        assert.fail("Cached query must not read pixels");
      },
    },
    generation: 7,
    _vitalityProbe: {
      latest: { generation: 7, coverage: 1, rgbEnergy: 0, hiddenEnergy: 0 },
    },
  });
  assert.equal(runtime.isDormant(), true);
  runtime._vitalityProbe.latest.hiddenEnergy = 0.3;
  assert.equal(runtime.isDormant(), false);
  runtime._vitalityProbe.latest.hiddenEnergy = 0;
  runtime._vitalityProbe.latest.coverage = 0;
  assert.equal(runtime.isDormant(), false);
  runtime._vitalityProbe.latest.coverage = 1;
  runtime.generation = 8;
  assert.equal(runtime.isDormant(), false);
  runtime.generation = 7;
  runtime.gl.isContextLost = () => true;
  assert.equal(runtime.isDormant(), false);
});

test("context loss and repeated runtime disposal delete all probe fences, buffers and targets", () => {
  for (const loseContext of [false, true]) {
    const { probe, gl, calls, update } = setup();
    update(0, 1);
    update(500, 2);
    let deletedTextures = 0,
      deletedFrames = 0;
    Object.assign(gl, {
      deleteTexture: () => deletedTextures++,
      deleteFramebuffer: () => deletedFrames++,
      deleteProgram() {},
      getExtension: () => null,
    });
    const runtime = Object.assign(Object.create(TextureNcaRuntime.prototype), {
      gl,
      generation: 1,
      _vitalityProbe: probe,
      textures: calls.targets.map((t) => t.texture),
      framebuffers: calls.targets.map((t) => t.framebuffer),
      programs: [],
      canvas: { removeEventListener() {}, width: 128, height: 128 },
    });
    if (loseContext) {
      runtime.handleContextLoss({ preventDefault() {} });
      assert.equal(probe.latest, null);
      assert.equal(runtime.monitorVitality(700, 10), null);
    }
    runtime.dispose();
    runtime.dispose();
    assert.equal(calls.deletedBuffers.length, 2);
    assert.equal(calls.deletedSyncs.length, 2);
    assert.equal(deletedTextures, 2);
    assert.equal(deletedFrames, 2);
    assert.equal(runtime.canvas.width, 1);
  }
});

test("continuous manual invalidation preserves cadence and needs fresh simulation updates", () => {
  const { probe, calls, update } = setup();
  update(0, 1);
  for (let time = 16; time < 500; time += 16) {
    probe.invalidate(time);
    update(time, 2, time);
  }
  assert.equal(calls.reads.length, 1);
  probe.invalidate(999);
  update(500, 2, 999);
  assert.equal(calls.reads.length, 2);
  for (let time = 516; time < 1200; time += 16) {
    probe.invalidate(time);
    update(time, 2, time);
  }
  assert.equal(
    calls.reads.length,
    2,
    "Manual generations without a new NCA step must not launch probes",
  );
});
