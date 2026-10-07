import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const read = (relative) => readFile(new URL(relative, root), "utf8");

test("application package and lockfile identify the MIT source license", async () => {
  const info = JSON.parse(await read("package.json"));
  const lock = JSON.parse(await read("package-lock.json"));
  assert.equal(info.license, "MIT");
  assert.equal(lock.packages[""].license, info.license);
  assert.match(await read("LICENSE"), /^MIT License\n/);
});

test("bundled decoder retains its checksum and separate research terms", async () => {
  const metadata = JSON.parse(await read("models/digiface/model-info.json"));
  const manifest = JSON.parse(await read("tools/model-assets.json"));
  const decoder = manifest.find(
    (entry) => entry.path === "models/digiface/" + metadata.file,
  );
  const weights = await readFile(new URL(decoder.path, root));
  assert.equal(weights.length, decoder.bytes);
  assert.equal(
    createHash("sha256").update(weights).digest("hex"),
    metadata.sha256,
  );
  assert.equal(metadata.sha256, decoder.sha256);
  assert.equal(metadata.trainingProvenance.trainedFromScratch, true);
  assert.equal(metadata.trainingProvenance.pretrainedInitialization, false);
  assert.equal(metadata.intendedUse, "non-commercial research");
  assert.match(await read(metadata.modelTerms), /non-commercial research only/);
  assert.match(
    await read("models/digiface/NOTICE.txt"),
    /not cover these weights/,
  );
});
