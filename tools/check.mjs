import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyModelAssets } from "./model-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(path.join(root, "index.html"), "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
if (new Set(ids).size !== ids.length)
  throw new Error("Duplicate HTML element IDs.");
const bindings = await readFile(
  path.join(root, "assets/js/app/dom-elements.js"),
  "utf8",
);
for (const [, id] of bindings.matchAll(/getElementById\("([^"]+)"\)/g)) {
  if (!ids.includes(id)) throw new Error("Missing DOM binding: " + id);
}

async function scriptsIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await scriptsIn(full)));
    else if (/\.(m?js)$/.test(entry.name)) files.push(full);
  }
  return files;
}
const files = [
  ...(await scriptsIn(path.join(root, "assets/js"))),
  ...(await scriptsIn(path.join(root, "tools"))),
  path.join(root, "server.mjs"),
];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const source = await readFile(file, "utf8");
  // Resolve local static imports and literal dynamic imports without importing browser code in Node.
  for (const [, specifier] of source.matchAll(
    /(?:from\s*|import\s*\(?\s*)["'](\.[^"']+)["']/g,
  )) {
    await access(path.resolve(path.dirname(file), specifier));
  }
}
for (const relative of [
  "assets/vendor/onnxruntime/ort.webgpu.bundle.min.mjs",
  "assets/vendor/onnxruntime/ort.wasm.bundle.min.mjs",
  "assets/vendor/onnxruntime/ort-wasm-simd-threaded.asyncify.wasm",
  "assets/vendor/onnxruntime/ort-wasm-simd-threaded.wasm",
  "assets/vendor/tensorflow/tf.min.js",
  "assets/vendor/tensorflow/tf-backend-webgpu.min.js",
  "licenses/onnxruntime-MIT.txt",
  "licenses/tensorflow-Apache-2.0.txt",
  "LICENSE",
  "licenses/digiface-decoder-research.txt",
  "models/digiface/NOTICE.txt",
  "models/digiface/README.txt",
  "models/digiface/model-info.json",
  "models/neural-growth/NOTICE.md",
  "licenses/neural-growth-Apache-2.0.txt",
])
  await access(path.join(root, relative));
await verifyModelAssets(root);
console.log(
  "Source syntax, imports, DOM bindings, runtimes, and model integrity: PASS",
);
