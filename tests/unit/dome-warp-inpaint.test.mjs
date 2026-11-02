import test from "node:test";
import assert from "node:assert/strict";
import { DomeJourney } from "../../assets/js/models/dome-journey.js";
import {
  DomeJourneyFields,
  RoomTexturePool,
  cosineBorderKeep,
  frontierEntryEdge,
} from "../../assets/js/models/dome-journey-fields.js";
import {
  getRoomTypology,
  dreamCellHash,
} from "../../assets/js/models/dome-journey-layout.js";
import { MiganInpainter } from "../../assets/js/models/migan-inpainter.js";
const settle = () => new Promise((r) => setImmediate(r));

function setup(extra = {}) {
  let task,
    commits = 0,
    fills = 0;
  const signals = [],
    releases = [];
  const fields = new DomeJourneyFields({
    prepare: (_image, region) => ({
      canvas: { region },
      known: new Uint8Array([255, 0]),
    }),
    feather: (image) => image,
    fallbackDepth: () => ({
      depth: new Float32Array([0.5]),
      width: 1,
      height: 1,
    }),
    createFrontierWorkers: () => ({
      inpainter: {
        prepare: async () => ({ type: "ready" }),
        cancel: () => releases.push("fill"),
        inpaintMasked: async (_canvas, _mask, { signal }) => {
          signals.push(signal);
          fills++;
          return { width: 2, height: 1 };
        },
      },
      depthEstimator: {
        estimate: async (_image, { signal }) => {
          signals.push(signal);
          return { depth: new Float32Array([0.8]), width: 1, height: 1 };
        },
        dispose: () => releases.push("depth"),
      },
    }),
    onCommit: () => commits++,
    ...extra,
  });
  const journey = new DomeJourney(42);
  journey.enabled = true;
  journey.onWarpStart = (node, warp) => {
    task = fields.generateFrontierNode(
      node.id,
      node.cell,
      {},
      { seed: 42, from: warp.from, to: warp.to },
    );
  };
  journey.onWarpComplete = (warp) => fields.completeFrontier(warp.id);
  journey.onWarpCancel = () => fields.cancelFrontier();
  return {
    fields,
    journey,
    signals,
    releases,
    get task() {
      return task;
    },
    get commits() {
      return commits;
    },
    get fills() {
      return fills;
    },
  };
}

test("warp launches local fill, then depth; completed textures commit only at the five-second blossom", async () => {
  const p = setup();
  assert.equal(p.journey.startWarp("0,-1"), true);
  await p.task;
  assert.equal(p.fills, 1);
  assert.equal(p.commits, 0);
  assert.equal(p.fields.pool.entries.size, 0);
  p.journey.advanceWarp(4.25);
  assert.equal(p.journey.warpProgress, 0.85);
  assert.equal(p.commits, 0);
  p.journey.advanceWarp(0.75);
  assert.equal(p.journey.warping, false);
  assert.equal(p.journey.warpProgress, 1);
  assert.equal(p.commits, 1);
  const room = p.fields.pool.get("0,-1");
  assert.equal(room.generator, "MI-GAN");
  assert.equal(room.depth.kind, "estimated");
  assert.deepEqual(
    p.journey.position,
    p.journey.discovered.get("0,-1").position,
  );
  assert.deepEqual(p.journey.warpUniform, [0, 0, 0, 0]);
  p.journey.home();
  p.journey.startWarp("0,-1");
  await p.task;
  assert.equal(p.fills, 1, "cached revisits skip inference");
});

test("Esc cancellation aborts in-flight work and late resolutions cannot commit", async () => {
  let finish;
  const p = setup();
  const native = p.fields.createFrontierWorkers;
  p.fields.createFrontierWorkers = () => {
    const workers = native();
    workers.inpainter.inpaintMasked = (_canvas, _mask, { signal }) => {
      p.signals.push(signal);
      return new Promise((r) => {
        finish = r;
      });
    };
    return workers;
  };
  p.journey.startWarp("0,-1");
  await settle();
  p.journey.advanceWarp(2);
  p.journey.cancelWarp();
  assert.equal(p.signals[0].aborted, true);
  assert.ok(p.releases.includes("fill"));
  assert.ok(p.releases.includes("depth"));
  finish({});
  await p.task;
  assert.equal(p.commits, 0);
  assert.equal(p.fields.pool.entries.size, 0);
  assert.equal(p.journey.move(1, 0, 0.1, 0), true);
});

test("slow generation does not stretch warp or pop new textures into the current room", async () => {
  let finish;
  const p = setup(),
    native = p.fields.createFrontierWorkers;
  p.fields.createFrontierWorkers = () => {
    const workers = native();
    workers.depthEstimator.estimate = () =>
      new Promise((r) => {
        finish = r;
      });
    return workers;
  };
  p.journey.startWarp("0,-1");
  await settle();
  p.journey.advanceWarp(5);
  assert.equal(p.journey.warping, false);
  assert.equal(p.commits, 0);
  finish({ depth: new Float32Array([0.5]), width: 1, height: 1 });
  await p.task;
  assert.equal(p.fields.pool.get("0,-1").deferred, true);
  assert.equal(p.commits, 0);
  const fakeGL = {};
  p.fields.pool.upload = () => null;
  p.fields.roomBindings(p.journey.position, p.journey.seed, fakeGL);
  assert.equal(
    p.fields.pool.get("0,-1").deferred,
    true,
    "staying in the room preserves its current textures",
  );
  p.fields.roomBindings([0, 0], p.journey.seed, fakeGL);
  p.fields.roomBindings(p.journey.position, p.journey.seed, fakeGL);
  assert.equal(
    p.fields.pool.get("0,-1").deferred,
    false,
    "walking away and back activates the cached room too",
  );
  p.journey.home();
  p.journey.startWarp("0,-1");
  await p.task;
  p.journey.advanceWarp(5);
  assert.equal(p.fields.pool.get("0,-1").deferred, false);
});

test("missing MI-GAN falls back to Inception, and depth failure keeps labeled brightness relief", async () => {
  const p = setup({
    fromResult: (result) => result,
    restore: (result) => result,
    createFrontierWorkers: () => ({
      inpainter: { prepare: async () => ({ type: "missing" }), cancel() {} },
      baker: {
        dispose() {},
        async bake(
          _image,
          _layer,
          _channel,
          _steps,
          { signal, preserveDetail },
        ) {
          assert.equal(signal.aborted, false);
          assert.equal(preserveDetail, true);
          return {};
        },
      },
      depthEstimator: {
        dispose() {},
        estimate: async () => {
          throw Error("offline");
        },
      },
    }),
  });
  p.journey.startWarp("0,-1");
  await p.task;
  p.journey.advanceWarp(5);
  const room = p.fields.pool.get("0,-1");
  assert.equal(room.generator, "Inception");
  assert.equal(room.depth.kind, "luminance");
  assert.equal(room.depth.error, "offline");
});

test("room typologies are seed-stable and directional cosine feathers preserve corridor borders", () => {
  const seen = new Set();
  for (let z = -5; z <= 5; z++)
    for (let x = -5; x <= 5; x++) {
      const t = getRoomTypology(x, z, 123);
      assert.equal(t.id, dreamCellHash(x, z, 123) % 4);
      seen.add(t.id);
    }
  assert.equal(seen.size, 4);
  assert.equal(getRoomTypology(2, 4, 123), getRoomTypology(2, 4, 123));
  assert.equal(frontierEntryEdge([0, 0], [20, 0]), "left");
  assert.equal(frontierEntryEdge([0, 0], [0, -20]), "bottom");
  assert.equal(cosineBorderKeep(0, 50, 100, 100, "left"), 1);
  assert.equal(cosineBorderKeep(50, 50, 100, 100, "left"), 0);
  assert.ok(
    cosineBorderKeep(12, 50, 100, 100, "left") >
      cosineBorderKeep(12, 50, 100, 100, "right"),
  );
});

test("GPU LRU owns at most eight room pairs, respects visits, and deletes both textures on eviction/reset", () => {
  const deleted = [],
    pool = new RoomTexturePool();
  const gl = { deleteTexture: (texture) => deleted.push(texture) };
  pool.attach(gl);
  for (let x = 0; x < 8; x++)
    pool.put(`${x},0`, { cell: [x, 0], gpu: [`c${x}`, `d${x}`] });
  pool.get("0,0");
  pool.put("8,0", { cell: [8, 0], gpu: ["c8", "d8"] });
  assert.equal(pool.entries.size, 8);
  assert.equal(pool.entries.has("0,0"), true);
  assert.equal(pool.entries.has("1,0"), false);
  assert.deepEqual(deleted, ["c1", "d1"]);
  pool.clear();
  assert.equal(deleted.length, 18);
  assert.equal(pool.entries.size, 0);
  pool.put("0,0", { gpu: ["lost-color", "lost-depth"] });
  pool.releaseGPU(false);
  assert.equal(deleted.length, 18);
  assert.equal(pool.get("0,0").gpu, null);
});

test("MI-GAN AbortSignal terminates the actual worker, including abort during bitmap capture", async () => {
  let close = 0,
    terminate = 0,
    capture;
  const inpainter = new MiganInpainter({
    capture: () =>
      new Promise((r) => {
        capture = r;
      }),
    createWorker: () => ({
      postMessage() {},
      terminate() {
        terminate++;
      },
    }),
  });
  const abort = new AbortController(),
    task = inpainter.inpaintMasked({}, new Uint8Array(1), {
      signal: abort.signal,
    });
  abort.abort();
  capture({
    width: 1,
    height: 1,
    close() {
      close++;
    },
  });
  await assert.rejects(task, { name: "AbortError" });
  assert.equal(close, 1);
  inpainter.capture = async () => ({ width: 1, height: 1, close() {} });
  const controller = new AbortController(),
    pending = inpainter.inpaintMasked({}, new Uint8Array(1), {
      signal: controller.signal,
    });
  await settle();
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(terminate, 1);
});
