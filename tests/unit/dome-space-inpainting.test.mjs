import test from "node:test";
import assert from "node:assert/strict";
import {
  packMaskedMiganInputs,
  compositeMaskedMigan,
} from "../../assets/js/models/migan-inpainter.js";
import { DomeJourneyFields } from "../../assets/js/models/dome-journey-fields.js";

const prepare = (source, region) => ({
  canvas: { source, region: region.id },
  known: new Uint8Array([255, 0, 255, 0]),
});
const settle = () => new Promise((r) => setImmediate(r));
function pipeline(extra = {}) {
  const events = [];
  const inpainter = {
    cancel() {
      events.push("release");
    },
    async prepare() {
      return { type: "ready" };
    },
    async inpaintMasked(canvas, mask) {
      events.push(canvas.region);
      return { canvas, mask };
    },
  };
  const fields = new DomeJourneyFields({ inpainter, prepare, ...extra });
  return { fields, events, inpainter };
}
test("arbitrary masks pack into NCHW and preserve every known pixel exactly", () => {
  const rgba = Uint8ClampedArray.from([
    10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160,
  ]);
  const known = new Uint8Array([255, 0, 255, 0]);
  const before = rgba.slice();
  const packed = packMaskedMiganInputs(rgba, 2, 2, known);
  assert.deepEqual(
    [...packed.image],
    [10, 50, 90, 130, 20, 60, 100, 140, 30, 70, 110, 150],
  );
  const result = compositeMaskedMigan(
    new Uint8Array(12).fill(222),
    rgba,
    known,
  );
  for (const i of [0, 2])
    assert.deepEqual(
      result.slice(i * 4, i * 4 + 4),
      rgba.slice(i * 4, i * 4 + 4),
    );
  assert.deepEqual([...result.slice(4, 8)], [222, 222, 222, 255]);
  assert.deepEqual(rgba, before);
  assert.throws(
    () => packMaskedMiganInputs(rgba, 2, 2, new Uint8Array(3)),
    RangeError,
  );
});
test("four regional MI-GAN fills commit together, use original context and skip Inception by default", async () => {
  const source = { original: true };
  let commits = 0,
    neural = 0;
  const { fields, events } = pipeline({
    baker: {
      cancel() {},
      dispose() {},
      bake() {
        neural++;
      },
    },
    onCommit: () => commits++,
  });
  assert.equal(await fields.generate(source, "mixed_6a", 42), true);
  assert.equal(commits, 1);
  assert.equal(neural, 0);
  assert.equal(fields.images.length, 4);
  assert.ok(fields.images.every((i) => i.canvas.source === source));
  assert.deepEqual(source, { original: true });
  assert.deepEqual(
    events.filter((s) => s !== "release"),
    ["arches", "lattice", "ribbons", "cavern"],
  );
  assert.ok(fields.metrics.every((m) => m.generator === "MI-GAN"));
});
test("depth starts after regional generation is released and commits with the images", async () => {
  let fields;
  const seen = [];
  const p = pipeline({
    depthEstimator: {
      cancel() {},
      dispose() {},
      async estimate(image) {
        assert.equal(fields.images.length, 0);
        assert.equal(p.events.at(-1), "release");
        seen.push(image);
        return { depth: new Float32Array([0.5]), width: 1, height: 1 };
      },
    },
  });
  fields = p.fields;
  assert.equal(await fields.generate({}, "mixed_6a", 42), true);
  assert.deepEqual(seen, fields.images);
  assert.equal(fields.depthMaps.length, 4);
  assert.ok(fields.depthMaps.every((d) => d.kind === "estimated"));
});
test("optional neuron refinement restores known pixels and uses the selected neuron", async () => {
  const calls = [],
    restored = [];
  const { fields } = pipeline({
    baker: {
      cancel() {},
      dispose() {},
      async bake(image, layer, channel, iterations, options) {
        calls.push({ layer, channel, iterations, options });
        return { rgba: new Uint8Array(4), width: 1, height: 1 };
      },
    },
    fromResult: (r) => r,
    restore: (result, original, known) => {
      restored.push({ original, known });
      return result;
    },
  });
  assert.equal(
    await fields.generate({}, "mixed_6d", 182, 1, { neuralDetail: true }),
    true,
  );
  assert.equal(restored.length, 4);
  assert.ok(
    calls.every(
      (c) =>
        c.layer === "mixed_6d" && c.channel === 182 && c.options.preserveDetail,
    ),
  );
});
test("cancellation and late depth results retain the previous complete space", async () => {
  let finish;
  const { fields } = pipeline({
    depthEstimator: {
      cancel() {},
      dispose() {},
      estimate: () => new Promise((r) => (finish = r)),
    },
  });
  const old = (fields.images = ["old"]),
    oldDepth = (fields.depthMaps = ["depth"]);
  const pending = fields.generate({}, "mixed_6a", 42);
  await settle();
  fields.cancel();
  finish({ depth: new Float32Array([0]), width: 1, height: 1 });
  assert.equal(await pending, false);
  assert.equal(fields.images, old);
  assert.equal(fields.depthMaps, oldDepth);
  fields.reset();
  assert.deepEqual(fields.images, []);
  assert.deepEqual(fields.depthMaps, []);
});
test("missing models and failed regional jobs never replace the last good space", async () => {
  const { fields, inpainter } = pipeline();
  fields.images = ["old"];
  inpainter.prepare = async () => ({ type: "missing" });
  assert.equal(await fields.generate({}, "mixed_6a", 42), false);
  assert.equal(fields.state, "missing");
  inpainter.prepare = async () => ({ type: "ready" });
  inpainter.inpaintMasked = async () => {
    throw Error("GPU lost");
  };
  assert.equal(await fields.generate({}, "mixed_6a", 42), false);
  assert.equal(fields.state, "error");
  assert.deepEqual(fields.images, ["old"]);
});
test("depth failures are explicit and keep usable generated imagery", async () => {
  const { fields } = pipeline({
    depthEstimator: {
      cancel() {},
      dispose() {},
      async estimate() {
        throw Error("offline");
      },
    },
    fallbackDepth: () => ({
      depth: new Float32Array([0.5]),
      width: 1,
      height: 1,
    }),
  });
  assert.equal(await fields.generate({}, "mixed_6a", 42), true);
  assert.equal(fields.images.length, 4);
  assert.ok(fields.depthMaps.every((d) => d.kind === "luminance"));
  assert.match(fields.status, /brightness relief/);
});
