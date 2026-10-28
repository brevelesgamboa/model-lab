import { ensureOnnxRuntime, onnxRuntimeMode } from "../core/ort-runtime.js";
import {
  DEPTH_MODEL_ROOT,
  depthInputSize,
  imagenetRgb,
  normalizeDepth,
} from "./depth-data.js";

self.onmessage = async ({ data: { bitmap } }) => {
  let session, input, outputs, device;
  try {
    const status = (message) => self.postMessage({ type: "status", message });
    status("Downloading depth model… Brightness preview is available.");
    const fetchBytes = async (name) => {
      const response = await fetch(DEPTH_MODEL_ROOT + name, {
        cache: "force-cache",
      });
      if (!response.ok)
        throw new Error(`Depth model download failed (${response.status}).`);
      return new Uint8Array(await response.arrayBuffer());
    };
    const [ort, graph, weights] = await Promise.all([
      ensureOnnxRuntime(),
      fetchBytes("model_q4.onnx"),
      fetchBytes("model_q4.onnx_data"),
    ]);
    let backend = "wasm";
    const options = {
      externalData: [{ path: "model_q4.onnx_data", data: weights }],
      graphOptimizationLevel: "all",
    };
    status("Preparing depth model… Brightness preview is available.");
    if (onnxRuntimeMode() === "webgpu") {
      try {
        const adapter = await navigator.gpu.requestAdapter({
          powerPreference: "high-performance",
        });
        const info = adapter?.info;
        const software =
          info?.isFallbackAdapter ||
          /swiftshader|llvmpipe|lavapipe|software/i.test(
            `${info?.architecture} ${info?.description}`,
          );
        if (adapter && !software) {
          device = await adapter.requestDevice({
            requiredFeatures: adapter.features.has("shader-f16")
              ? ["shader-f16"]
              : [],
          });
          ort.env.webgpu.device = device;
          session = await ort.InferenceSession.create(graph, {
            ...options,
            executionProviders: ["webgpu"],
          });
          backend = "webgpu";
        }
      } catch {
        /* A failed GPU initialization has not run inference yet. */
      }
    }
    session ??= await ort.InferenceSession.create(graph, {
      ...options,
      executionProviders: ["wasm"],
    });
    const [width, height] = depthInputSize(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    input = new ort.Tensor(
      "float32",
      imagenetRgb(ctx.getImageData(0, 0, width, height).data, width, height),
      [1, 3, height, width],
    );
    status(`Estimating depth once (${backend.toUpperCase()})…`);
    const started = performance.now();
    outputs = await session.run({ [session.inputNames[0]]: input });
    const tensor = outputs[session.outputNames[0]],
      values = await tensor.getData();
    const inferenceMs = performance.now() - started;
    const [outHeight, outWidth] = tensor.dims.slice(-2);
    if (values.length !== outWidth * outHeight)
      throw new Error("Unexpected depth output shape.");
    const depth = normalizeDepth(values);
    input.dispose();
    input = null;
    for (const output of Object.values(outputs)) output.dispose();
    outputs = null;
    await session.release();
    session = null;
    device?.destroy();
    device = null;
    bitmap.close();
    self.postMessage(
      {
        type: "result",
        depth,
        width: outWidth,
        height: outHeight,
        backend,
        inferenceMs,
      },
      [depth.buffer],
    );
  } catch (error) {
    self.postMessage({ type: "error", error: error.message });
  } finally {
    input?.dispose();
    if (outputs) for (const output of Object.values(outputs)) output.dispose();
    await session?.release();
    device?.destroy();
    bitmap.close();
    self.close();
  }
};
