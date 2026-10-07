let runtimePromise = null;
let webGpuPromise = null;
const TF_URL = new URL("../../vendor/tensorflow/tf.min.js", import.meta.url)
  .href;
const WEBGPU_URL = new URL(
  "../../vendor/tensorflow/tf-backend-webgpu.min.js",
  import.meta.url,
).href;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.latentFieldRuntime = "tensorflow-js";
    script.onload = resolve;
    script.onerror = () => {
      script.remove();
      reject(
        new Error(`Could not load ${src}. Run npm install and npm run build.`),
      );
    };
    document.head.append(script);
  });
}

export async function ensureTensorFlow() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      if (!globalThis.tf) await loadScript(TF_URL);
      const tf = globalThis.tf;
      if (!tf) throw new Error("TensorFlow.js did not expose its runtime.");
      await tf.ready();
      return tf;
    })().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  const tf = await runtimePromise;
  if (globalThis.navigator?.gpu && !tf.findBackendFactory("webgpu")) {
    webGpuPromise ??= loadScript(WEBGPU_URL).catch((error) => {
      console.warn("TensorFlow WebGPU unavailable; retaining WebGL.", error);
    });
    await webGpuPromise;
  }
  return tf;
}

export async function activateTensorFlowBackend(
  preferred = ["webgpu", "webgl"],
) {
  const tf = await ensureTensorFlow();
  for (const backend of preferred) {
    if (!tf.findBackendFactory(backend)) continue;
    try {
      if (!(await tf.setBackend(backend))) continue;
      await tf.ready();
      if (tf.getBackend() === backend) return tf;
    } catch (error) {
      console.warn(`TensorFlow backend ${backend} is unavailable.`, error);
    }
  }
  throw new Error(`No supported TensorFlow backend: ${preferred.join(", ")}.`);
}

export function tensorFlowRuntimeUrl() {
  return TF_URL;
}
