import test from "node:test";
import assert from "node:assert/strict";
import * as tf from "@tensorflow/tfjs";
import {
  applyDomeColorStep,
  constrainDomeColor,
  optimizeDomeDream,
} from "../../assets/js/models/dome-dream-optimizer.js";
import {
  MiganLoader,
  miganCache,
  validateMiganSession,
} from "../../assets/js/models/migan-loader.js";
import {
  packMiganInputs,
  compositeMigan,
  MiganInpainter,
} from "../../assets/js/models/migan-inpainter.js";
import { photoPlacement } from "../../assets/js/models/equirectangular-canvas.js";
import { blurredLuminance } from "../../assets/js/models/depth-data.js";

const chroma = ([r, g, b]) => [
  -0.168736 * r - 0.331264 * g + 0.5 * b,
  0.5 * r - 0.418688 * g - 0.081312 * b,
];
test("luma steps freeze chroma including saturated gamut limits; reduced retention admits chroma", async () => {
  await tf.setBackend("cpu");
  await tf.ready();
  const before = tf.memory().numTensors;
  tf.tidy(() => {
    const source = tf.tensor4d(
      [0.2, 0.4, 0.6, 1, 0, 0.4, 0.02, 0.01, 0.03],
      [1, 1, 3, 3],
    );
    const gradient = tf.tensor4d([2, -1, 5, 7, 2, -6, -5, -1, 3], [1, 1, 3, 3]);
    const locked = constrainDomeColor(
      tf,
      applyDomeColorStep(tf, source, gradient, 1, 1),
      source,
      1,
    ).dataSync();
    const base = source.dataSync();
    for (let p = 0; p < 3; p++) {
      const orig = chroma([...base.slice(p * 3, p * 3 + 3)]),
        next = chroma([...locked.slice(p * 3, p * 3 + 3)]);
      for (let c = 0; c < 2; c++) assert.ok(Math.abs(orig[c] - next[c]) < 1e-6);
    }
    assert.ok([...locked].every((x) => x >= 0 && x <= 1));
    const free = applyDomeColorStep(tf, source, gradient, 0.01, 0).dataSync();
    for (let i = 0; i < 9; i++)
      assert.ok(
        Math.abs(free[i] - base[i] - gradient.dataSync()[i] * 0.01) < 1e-6,
      );
    assert.ok(
      Math.abs(
        chroma([...free.slice(0, 3)])[0] - chroma([...base.slice(0, 3)])[0],
      ) > 0.01,
    );
  });
  assert.equal(tf.memory().numTensors, before);
});

test("default luma ascent preserves each pixel's chroma through octaves and spherical constraints", async () => {
  await tf.setBackend("cpu");
  const w = 320,
    h = 160,
    data = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      data.set(
        [0.2 + (0.2 * x) / w, 0.25 + (0.1 * y) / h, 0.55],
        (y * w + x) * 3,
      );
  const seed = tf.tensor4d(data, [1, h, w, 3]),
    count = tf.memory().numTensors;
  try {
    const result = await optimizeDomeDream(
      tf,
      { execute: (x) => x.square() },
      seed,
      { node: "fixture", channel: 0, photoRect: null, iterations: 4 },
    );
    let changed = 0;
    for (let i = 0; i < w * h; i++) {
      const original = [...data.slice(i * 3, i * 3 + 3)],
        next = [...result.rgba.slice(i * 4, i * 4 + 3)].map((x) => x / 255);
      for (let c = 0; c < 2; c++)
        assert.ok(Math.abs(chroma(original)[c] - chroma(next)[c]) < 0.0041);
      changed += Math.abs(next[0] - original[0]);
    }
    assert.ok(changed > 10);
    assert.equal(result.sizes.length, 2);
    assert.equal(tf.memory().numTensors, count);
  } finally {
    seed.dispose();
  }
});

function session() {
  return {
    inputNames: ["image", "mask"],
    outputNames: ["result"],
    inputMetadata: [
      { name: "image", type: "uint8", shape: [1, 3, "h", "w"] },
      { name: "mask", type: "uint8", shape: [1, 1, "h", "w"] },
    ],
    release: async () => {},
  };
}
function fixture({
  cached = null,
  local = false,
  failGpu = false,
  invalid = false,
  deny = false,
} = {}) {
  const calls = [],
    state = { cached },
    runtime = async () => ({
      InferenceSession: {
        create: async (buffer, options) => {
          calls.push(["compile", options.executionProviders]);
          if (failGpu && options.executionProviders.includes("webgpu"))
            throw Error("GPU unavailable");
          if (invalid || new Uint8Array(buffer)[0] === 0)
            throw Error("Bad protobuf");
          return session();
        },
      },
    });
  const loader = new MiganLoader({
    runtime,
    mode: () => "webgpu",
    cache: async (action, buffer) => {
      calls.push([action]);
      if (deny) throw Error("Quota");
      if (action === "get") return state.cached;
      if (action === "put") state.cached = buffer;
      if (action === "delete") state.cached = null;
    },
    fetcher: async (_url, options) => {
      calls.push(["fetch", options?.method || "GET"]);
      return new Response(new Uint8Array([1, 2, 3]), {
        status: local ? 200 : 404,
      });
    },
  });
  return { loader, calls, state };
}
test("MI-GAN uses memory then IndexedDB before network and deduplicates compilation", async () => {
  const { loader, calls } = fixture({ cached: new Uint8Array([1]).buffer });
  const [a, b] = await Promise.all([loader.get(), loader.get()]);
  assert.equal(a, b);
  assert.equal(await loader.get(), a);
  assert.equal(a.miganInfo.origin, "Cached");
  assert.equal(a.miganInfo.cached, true);
  assert.deepEqual(calls, [["get"], ["compile", ["webgpu", "wasm"]]]);
});
test("MI-GAN probes the local file, persists valid weights, and retries WASM if WebGPU fails", async () => {
  const { loader, calls, state } = fixture({ local: true, failGpu: true });
  const s = await loader.get();
  assert.equal(s.miganInfo.backend, "WASM");
  assert.ok(state.cached instanceof ArrayBuffer);
  assert.deepEqual(
    calls.map((x) => x[0]),
    ["get", "fetch", "fetch", "compile", "compile", "put"],
  );
  assert.deepEqual(calls[1], ["fetch", "HEAD"]);
});
test("missing/corrupt cache prompts once; invalid uploads are never persisted; denied storage still allows a session", async () => {
  const f = fixture({ cached: new Uint8Array([0]).buffer });
  let prompts = 0;
  assert.equal(
    await f.loader.get(() => {
      prompts++;
      return null;
    }),
    null,
  );
  assert.equal(prompts, 1);
  assert.ok(f.calls.some((x) => x[0] === "delete"));
  const bad = fixture({ invalid: true });
  await assert.rejects(
    bad.loader.fromFile({
      name: "bad.onnx",
      size: 4,
      arrayBuffer: async () => new ArrayBuffer(4),
    }),
    /Bad protobuf/,
  );
  assert.ok(!bad.calls.some((x) => x[0] === "put"));
  await assert.rejects(
    bad.loader.fromFile({ name: "image.png", size: 4 }),
    /Choose/,
  );
  const denied = fixture({ deny: true });
  const valid = await denied.loader.fromFile({
    name: "migan_pipeline_v2.onnx",
    size: 1,
    arrayBuffer: async () => new Uint8Array([1]).buffer,
  });
  assert.equal(valid.miganInfo.cached, false);
  const wrong = session();
  wrong.inputMetadata[0].type = "float32";
  assert.throws(() => validateMiganSession(wrong), /uint8/);
});
test("MI-GAN packs channel-first bytes with correct mask polarity, preserves photo core and closes panorama edges", () => {
  const w = 96,
    h = 48,
    source = new Uint8ClampedArray(w * h * 4),
    rect = { x: 30, y: 12, width: 36, height: 24 };
  for (let i = 0; i < w * h; i++) source.set([30, 70, 110, 255], i * 4);
  const { image, mask } = packMiganInputs(source, w, h, rect);
  assert.deepEqual([image[0], image[w * h], image[2 * w * h]], [30, 70, 110]);
  assert.equal(mask[0], 0);
  assert.equal(mask[24 * w + 48], 255);
  const generated = new Uint8Array(w * h * 3);
  for (let i = 0; i < generated.length; i++) generated[i] = i % 251;
  const out = compositeMigan(generated, source, w, h, rect);
  assert.deepEqual(
    [...out.slice((24 * w + 48) * 4, (24 * w + 48) * 4 + 4)],
    [30, 70, 110, 255],
  );
  for (let y = 0; y < h; y++)
    for (let c = 0; c < 4; c++)
      assert.equal(out[y * w * 4 + c], out[(y * w + w - 1) * 4 + c]);
  for (const y of [0, h - 1])
    for (let x = 0; x < w; x++)
      assert.deepEqual(
        [...out.slice((y * w + x) * 4, (y * w + x) * 4 + 4)],
        [...out.slice(y * w * 4, y * w * 4 + 4)],
      );
});
test("cancelling MI-GAN rejects compilation and captured frames cannot start a stale job", async () => {
  const workers = [],
    captures = [];
  const m = new MiganInpainter({
    createWorker: () => {
      const w = {
        postMessage() {},
        terminate() {
          this.terminated = true;
        },
      };
      workers.push(w);
      return w;
    },
    capture: () => new Promise((r) => captures.push(r)),
  });
  const prepare = m.prepare(),
    reject = assert.rejects(prepare, { name: "AbortError" });
  m.cancel();
  await reject;
  assert.equal(workers[0].terminated, true);
  const capture = m.inpaint({}),
    rejected = assert.rejects(capture, { name: "AbortError" });
  m.cancel();
  let closed = false;
  captures[0]({
    close() {
      closed = true;
    },
  });
  await rejected;
  assert.equal(closed, true);
  assert.equal(workers.length, 1);
});

test("missing IndexedDB never reports successful persistence", async () => {
  assert.equal(await miganCache("get", undefined, null), null);
  await assert.rejects(
    miganCache("put", new ArrayBuffer(1), null),
    /unavailable/,
  );
});

test("immersive coverage expands photo dimensions and full 360 luminance depth spans entire equirectangular canvas", () => {
  const standard = photoPlacement(1920, 1080, 1024, 512, { coverage: "standard" });
  const immersive = photoPlacement(1920, 1080, 1024, 512, { coverage: "immersive" });
  assert.equal(standard.width, 341);
  assert.equal(standard.height, 192);
  assert.equal(immersive.width, 532);
  assert.equal(immersive.height, 300);
  assert.ok(immersive.width * immersive.height > 2.4 * standard.width * standard.height);

  // Generate 64x32 mock RGBA buffer representing a full 360 panorama
  const w = 64, h = 32;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      rgba[idx] = Math.round(50 + (150 * x) / w);
      rgba[idx + 1] = Math.round(60 + (140 * y) / h);
      rgba[idx + 2] = 128;
      rgba[idx + 3] = 255;
    }
  }
  const depth = blurredLuminance(rgba, w, h);
  assert.equal(depth.length, w * h);
  assert.ok(depth[0] >= 0);
  assert.equal(Math.max(...depth), 1);
  assert.equal(Math.min(...depth), 0);
  assert.ok([...depth].every((d) => Number.isFinite(d) && d >= 0 && d <= 1));
});
