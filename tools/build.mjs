import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyModelAssets } from "./model-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "dist");
const packageInfo = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
await verifyModelAssets(root);

// dist is generated. Never copy the whole workspace or arbitrary model folders.
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const relative of [
  "index.html",
  "runtime-check.html",
  "LICENSE",
  "licenses",
  "THIRD_PARTY_NOTICES.md",
]) {
  await cp(path.join(root, relative), path.join(destination, relative), {
    recursive: true,
  });
}
for (const relative of ["assets/css", "assets/js"]) {
  await cp(path.join(root, relative), path.join(destination, relative), {
    recursive: true,
  });
}
const modelAssets = JSON.parse(
  await readFile(path.join(root, "tools/model-assets.json"), "utf8"),
);
const staticFiles = [
  "models/neural-growth/NOTICE.md",
  ...modelAssets.map((entry) => entry.path),
  "models/digiface/README.txt",
  "models/digiface/model-info.json",
  "models/digiface/NOTICE.txt",
  "assets/vendor/onnxruntime/ort.webgpu.bundle.min.mjs",
  "assets/vendor/onnxruntime/ort.wasm.bundle.min.mjs",
  "assets/vendor/onnxruntime/ort-wasm-simd-threaded.asyncify.wasm",
  "assets/vendor/onnxruntime/ort-wasm-simd-threaded.wasm",
  "assets/vendor/onnxruntime/LICENSE",
  "assets/vendor/tensorflow/tf.min.js",
  "assets/vendor/tensorflow/tf-backend-webgpu.min.js",
  "assets/vendor/tensorflow/LICENSE",
];
for (const relative of staticFiles) {
  await mkdir(path.dirname(path.join(destination, relative)), {
    recursive: true,
  });
  await cp(path.join(root, relative), path.join(destination, relative));
}
await verifyModelAssets(destination);
await writeFile(
  path.join(destination, "build-info.json"),
  JSON.stringify(
    {
      name: "Latent Field",
      version: packageInfo.version,
      builtAt: new Date().toISOString(),
      buildType: "static-local-onnx-tfjs",
    },
    null,
    2,
  ) + "\n",
);
console.log("Build complete: " + destination);
