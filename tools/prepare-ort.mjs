import { access, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const source = path.join(
  projectRoot,
  "node_modules",
  "onnxruntime-web",
  "dist",
);
const destination = path.join(projectRoot, "assets", "vendor", "onnxruntime");

try {
  await access(source);
} catch {
  console.error("ONNX Runtime Web is not installed. Run: npm install");
  process.exit(1);
}

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

// Bundled ESM builds embed their JavaScript glue; only their WASM binaries are needed.
const requiredRuntimeFiles = [
  "ort.webgpu.bundle.min.mjs",
  "ort.wasm.bundle.min.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.wasm",
];
for (const filename of requiredRuntimeFiles) {
  await cp(path.join(source, filename), path.join(destination, filename));
}
await cp(
  path.join(projectRoot, "licenses", "onnxruntime-MIT.txt"),
  path.join(destination, "LICENSE"),
);

for (const filename of requiredRuntimeFiles) {
  try {
    await access(path.join(destination, filename));
  } catch {
    console.error(`Missing ONNX Runtime Web asset: ${filename}`);
    console.error(`Installed package: ${source}`);
    console.error("Run npm ci to restore the locked runtime version.");
    process.exit(1);
  }
}

console.log(
  `Prepared ${requiredRuntimeFiles.length} ONNX Runtime Web assets in ${destination}`,
);
console.log(`Verified bundled runtime: ${requiredRuntimeFiles[0]}`);
