let runtimePromise = null;
let runtimeMode = "wasm";

export async function ensureOnnxRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      let runtime;
      if (globalThis.navigator?.gpu) {
        try {
          runtime =
            await import("../../vendor/onnxruntime/ort.webgpu.bundle.min.mjs");
          runtimeMode = "webgpu";
        } catch (error) {
          console.warn("ONNX WebGPU runtime unavailable; using WASM.", error);
        }
      }
      runtime ??=
        await import("../../vendor/onnxruntime/ort.wasm.bundle.min.mjs");
      runtime.env.logLevel = "error";
      runtime.env.wasm.numThreads = 1;
      runtime.env.wasm.proxy = false;
      return runtime;
    })().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

export function onnxRuntimeMode() {
  return runtimeMode;
}
