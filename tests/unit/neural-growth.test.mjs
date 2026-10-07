import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createSparseLayout,
  encodePerception,
  referenceStep,
  validateCheckpoint,
  validateSeed,
  validateSize,
} from "../../assets/js/models/neural-growth/reference.js";
import { TextureNcaRuntime } from "../../assets/js/models/neural-growth/runtime.js";
import { PATTERNS } from "../../assets/js/models/neural-growth/patterns.js";
import { createHash } from "node:crypto";

const checkpointUrl = new URL(
  "../../models/neural-growth/checkpoint.json",
  import.meta.url,
);

function fixture() {
  return {
    format: "latent-field-texture-nca-v1",
    id: "unit-fixture",
    name: "Unit fixture",
    layers: [
      { shape: [49, 96], scale: 1, weights: Array(49 * 96).fill(128) },
      { shape: [97, 12], scale: 1, weights: Array(97 * 12).fill(128) },
    ],
  };
}

test("the shipped checkpoint decodes the fixed Texture NCA weight layout", async () => {
  const raw = JSON.parse(await readFile(checkpointUrl, "utf8"));
  const model = validateCheckpoint(raw);
  assert.equal(model.format, "latent-field-texture-nca-v1");
  assert.equal(model.layers.length, 2);
  for (const [index, length] of [49 * 96, 97 * 12].entries()) {
    const layer = model.layers[index];
    assert.ok(layer.weights instanceof Uint8Array);
    assert.ok(layer.coefficients instanceof Float32Array);
    assert.equal(layer.weights.byteLength, length);
    assert.equal(layer.coefficients.length, length);
    assert.ok(layer.coefficients.every(Number.isFinite));
  }
});

test("every release pattern has a matching checkpoint and integrity manifest entry", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../../tools/model-assets.json", import.meta.url),
      "utf8",
    ),
  );
  const weights = new Set();
  for (const pattern of PATTERNS) {
    const bytes = await readFile(pattern.checkpointUrl);
    const raw = JSON.parse(bytes);
    const model = validateCheckpoint(raw);
    assert.equal(model.id, pattern.id);
    assert.equal(model.name, pattern.name);
    const relative = pattern.checkpointUrl.pathname.split("/models/")[1];
    const entry = manifest.find(({ path }) => path === `models/${relative}`);
    assert.ok(entry, `Missing asset: ${pattern.id}`);
    assert.equal(bytes.length, entry.bytes);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      entry.sha256,
    );
    const fingerprint = JSON.stringify(raw.layers);
    assert.ok(
      !weights.has(fingerprint),
      "Distinct patterns cannot share renamed weights.",
    );
    weights.add(fingerprint);
  }
});

test("checkpoint validation copies data instead of retaining mutable JSON arrays", () => {
  const raw = fixture();
  const model = validateCheckpoint(raw);
  raw.layers[0].weights[0] = 0;
  assert.equal(model.layers[0].weights[0], 128);
  assert.ok(Object.isFrozen(model));
  assert.ok(Object.isFrozen(model.layers[0]));
});

test("checkpoint validation rejects incompatible or malformed packs", () => {
  const mutations = [
    ["format", (raw) => (raw.format = "untrusted-format")],
    ["missing id", (raw) => (raw.id = "")],
    ["missing name", (raw) => (raw.name = "")],
    ["layer count", (raw) => raw.layers.pop()],
    ["input shape", (raw) => (raw.layers[0].shape = [48, 96])],
    ["output shape", (raw) => (raw.layers[1].shape = [97, 16])],
    ["missing weights", (raw) => delete raw.layers[0].weights],
    ["short weights", (raw) => raw.layers[0].weights.pop()],
    ["long weights", (raw) => raw.layers[1].weights.push(128)],
    ["negative byte", (raw) => (raw.layers[0].weights[0] = -1)],
    ["large byte", (raw) => (raw.layers[0].weights[0] = 256)],
    ["fractional byte", (raw) => (raw.layers[0].weights[0] = 0.5)],
    ["nonfinite byte", (raw) => (raw.layers[0].weights[0] = NaN)],
    ["zero scale", (raw) => (raw.layers[0].scale = 0)],
    ["negative scale", (raw) => (raw.layers[1].scale = -1)],
    ["large scale", (raw) => (raw.layers[0].scale = 9)],
    ["nonfinite scale", (raw) => (raw.layers[1].scale = Infinity)],
  ];
  for (const [label, mutate] of mutations) {
    const raw = fixture();
    mutate(raw);
    assert.throws(() => validateCheckpoint(raw), undefined, label);
  }
  for (const raw of [null, [], {}, "checkpoint"]) {
    assert.throws(() => validateCheckpoint(raw));
  }
});

test("simulation grids and seeds have explicit bounds", () => {
  for (const size of [8, 16, 32, 64, 128, 256]) {
    assert.equal(validateSize(size), size);
  }
  for (const size of [0, 7, 12, 129, 512, NaN, Infinity, 8.5]) {
    assert.throws(() => validateSize(size), undefined, `size ${size}`);
  }
  for (const seed of [0, 1, 4294967295]) {
    assert.equal(validateSeed(seed), seed);
  }
  for (const seed of [-1, 0.5, 4294967296, NaN, Infinity]) {
    assert.throws(() => validateSeed(seed), undefined, `seed ${seed}`);
  }
});

test("runtime rejects invalid size and seed before allocating browser resources", () => {
  const model = validateCheckpoint(fixture());
  assert.throws(() => new TextureNcaRuntime({ model, size: 129 }), /size/i);
  assert.throws(() => new TextureNcaRuntime({ model, seed: -1 }), /seed/i);
});

test("perception encoding defines half ties and saturation explicitly", () => {
  for (const [sum, expected] of [
    [0, 127],
    [4, 128],
    [-4, 127],
    [12, 129],
    [-12, 126],
    [4096, 255],
    [-4096, 0],
  ]) {
    assert.equal(encodePerception(sum), expected, `weighted sum ${sum}`);
  }
  for (const sum of [0.5, NaN, Infinity, -Infinity]) {
    assert.throws(() => encodePerception(sum));
  }
});

test("sparse cell layouts deterministically select exactly half the cells", () => {
  const first = createSparseLayout(8, 17);
  const second = createSparseLayout(8, 17);
  assert.ok(first.shuffle instanceof Uint8Array);
  assert.ok(first.inverse instanceof Uint8Array);
  assert.deepEqual(first.shuffle, second.shuffle);
  assert.deepEqual(first.inverse, second.inverse);
  assert.equal(first.random(), second.random());
  assert.equal(first.shuffle.length, 8 * 8 * 2);
  assert.equal(first.inverse.length, 8 * 8 * 4);
  const selectedCells = new Set();
  for (let index = 0; index < first.shuffle.length; index += 4) {
    const x = first.shuffle[index];
    const y = first.shuffle[index + 1];
    assert.ok(x < 8 && y < 8);
    selectedCells.add(y * 8 + x);
    const inverseIndex = (y * 8 + x) * 4;
    assert.equal(first.inverse[inverseIndex + 2], 255);
    assert.equal(first.inverse[inverseIndex], (index / 4) % 8);
    assert.equal(first.inverse[inverseIndex + 1], Math.floor(index / 4 / 8));
  }
  assert.equal(selectedCells.size, (8 * 8) / 2);
});

test("an empty update mask leaves all cell channels unchanged", () => {
  const model = validateCheckpoint(fixture());
  const size = 8;
  const state = Uint8Array.from(
    { length: size * size * 12 },
    (_, index) => (index * 37 + 11) % 256,
  );
  const previous = state.slice();
  const mask = new Uint8Array(size * size);
  const next = referenceStep(state, model, size, mask);
  assert.ok(next instanceof Uint8Array);
  assert.notEqual(next, state);
  assert.deepEqual(next, previous);
  assert.deepEqual(state, previous);
  assert.deepEqual(mask, new Uint8Array(size * size));
});

test("sparse updates preserve inactive cells and do not mutate input state", () => {
  const model = validateCheckpoint(fixture());
  const size = 8;
  const state = Uint8Array.from(
    { length: size * size * 12 },
    (_, index) => 96 + (index % 64),
  );
  const previous = state.slice();
  const mask = Uint8Array.from(
    { length: size * size },
    (_, index) => index % 2,
  );
  const next = referenceStep(state, model, size, mask);
  assert.equal(next.length, state.length);
  for (let cell = 0; cell < mask.length; cell += 1) {
    if (mask[cell] === 0) {
      assert.deepEqual(
        next.subarray(cell * 12, (cell + 1) * 12),
        state.subarray(cell * 12, (cell + 1) * 12),
      );
    }
  }
  assert.deepEqual(state, previous);
});

test("CPU reference rejects incorrectly sized state and update masks", () => {
  const model = validateCheckpoint(fixture());
  assert.throws(() =>
    referenceStep(new Uint8Array(8 * 8 * 12 - 1), model, 8, new Uint8Array(64)),
  );
  assert.throws(() =>
    referenceStep(new Uint8Array(8 * 8 * 12), model, 8, new Uint8Array(63)),
  );
  assert.throws(() =>
    referenceStep(
      new Uint8Array(8 * 8 * 12),
      model,
      8,
      new Uint8Array(64).fill(2),
    ),
  );
});
