import { createHash } from "node:crypto";
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
  "CITATIONS.md",
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
// The optional official MI-GAN file is copied only when explicitly installed.
// It is not a required release asset and is never downloaded by the build.
const optionalMigan = "models/inpainting/migan_pipeline_v2.onnx";
let migan;
try {
  migan = await readFile(path.join(root, optionalMigan));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (migan) {
  if (
    createHash("sha256").update(migan).digest("hex") !==
    "6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b"
  )
    throw new Error(
      "The optional MI-GAN model differs from pipeline v2. Use the file picker for custom models.",
    );
  await mkdir(path.dirname(path.join(destination, optionalMigan)), {
    recursive: true,
  });
  await cp(
    path.join(root, optionalMigan),
    path.join(destination, optionalMigan),
  );
}
await verifyModelAssets(destination);
await writeFile(
  path.join(destination, "build-info.json"),
  JSON.stringify(
    {
      name: "gl-bench",
      version: packageInfo.version,
      builtAt: new Date().toISOString(),
      buildType: "static-local-onnx-tfjs",
    },
    null,
    2,
  ) + "\n",
);
console.log("Build complete: " + destination);
