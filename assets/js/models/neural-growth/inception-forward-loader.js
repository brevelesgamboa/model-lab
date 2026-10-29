// Shared by the scalar sensor and one-shot spatial feature worker. Call from a
// classic worker: TF.js owns a separate WebGL context, away from the UI thread.
export async function loadInceptionForward({ runtimeUrl, modelUrl }) {
  if (!self.tf) self.importScripts(runtimeUrl);
  const tf = self.tf;
  tf.env().set("WEBGL_CPU_FORWARD", false);
  if (!(await tf.setBackend("webgl")))
    throw new Error("GPU inference is unavailable.");
  await tf.ready();
  const model = await tf.loadGraphModel(modelUrl, {
    streamWeights: true,
    fetchFunc: cachedModelFetch,
  });
  return { tf, model };
}
import { cachedModelFetch } from "../../core/local-model-cache.js";
