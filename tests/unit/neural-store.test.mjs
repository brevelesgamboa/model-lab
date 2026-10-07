import test from "node:test";
import assert from "node:assert/strict";
import { NeuralModelStore } from "../../assets/js/core/neural-model-store.js";

test("failed neural replacement preserves the committed model and cleans staged weights", async () => {
  const storage = new Map();
  const removed = [];
  globalThis.window = {
    localStorage: {
      getItem: (key) => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
    },
  };
  globalThis.tf = {
    ready: async () => {},
    io: { removeModel: async (url) => removed.push(url) },
  };
  const metadata = {
    latentDim: 64,
    profile: "datamosh",
    objective: "reconstruct",
    sampleNames: ["sample"],
    sampleLatents: [Array(64).fill(0)],
  };
  const previous = await NeuralModelStore.save({
    encoder: { save: async () => {} },
    decoder: { save: async () => {} },
    metadata: { ...metadata, name: "COMMITTED" },
  });
  let stagedEncoder;
  await assert.rejects(
    NeuralModelStore.save({
      encoder: {
        save: async (url) => {
          stagedEncoder = url;
        },
      },
      decoder: {
        save: async () => {
          throw new Error("Quota exceeded");
        },
      },
      metadata: { ...metadata, name: "FAILED" },
    }),
    /Quota exceeded/,
  );
  assert.equal(NeuralModelStore.loadMetadata().name, "COMMITTED");
  assert.equal(
    NeuralModelStore.loadMetadata().storage.encoder,
    previous.storage.encoder,
  );
  assert.ok(removed.includes(stagedEncoder));
  assert.ok(!removed.includes(previous.storage.encoder));
});
