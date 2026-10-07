import { access, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const source = path.join(
  projectRoot,
  "node_modules",
  "@tensorflow",
  "tfjs",
  "dist",
  "tf.min.js",
);
const destinationDir = path.join(projectRoot, "assets", "vendor", "tensorflow");
const destination = path.join(destinationDir, "tf.min.js");

try {
  await access(source);
} catch {
  throw new Error(
    "TensorFlow.js is not installed. Run npm ci before building.",
  );
}

await mkdir(destinationDir, { recursive: true });
await copyFile(source, destination);
await copyFile(
  path.join(
    projectRoot,
    "node_modules",
    "@tensorflow",
    "tfjs-backend-webgpu",
    "dist",
    "tf-backend-webgpu.min.js",
  ),
  path.join(destinationDir, "tf-backend-webgpu.min.js"),
);
await copyFile(
  path.join(projectRoot, "licenses", "tensorflow-Apache-2.0.txt"),
  path.join(destinationDir, "LICENSE"),
);
console.log(`Prepared TensorFlow.js runtime: ${destination}`);
