// Classic worker: TF.js and its WebGL context live entirely off the UI thread.
let model = null;
let weightsTensors = 0;
let busy = false;

async function load({ runtimeUrl, modelUrl, node, size }) {
  const started = performance.now();
  const { loadInceptionForward } =
    await import("./inception-forward-loader.js");
  const loaded = await loadInceptionForward({ runtimeUrl, modelUrl });
  const { tf } = loaded;
  model = loaded.model;
  // Warm the selected forward path without publishing the synthetic input.
  const warm = tf.tidy(() =>
    model.execute(tf.zeros([1, size, size, 3]), node).mean(),
  );
  try {
    await warm.data();
  } finally {
    warm.dispose();
  }
  weightsTensors = tf.memory().numTensors;
  self.postMessage({
    type: "ready",
    backend: tf.getBackend(),
    loadMs: performance.now() - started,
  });
}

async function observe({ id, bitmap, node, channel }) {
  if (busy) {
    bitmap.close();
    throw new Error("An inference is already running.");
  }
  busy = true;
  const tf = self.tf,
    started = performance.now();
  let scalar;
  try {
    scalar = tf.tidy(() => {
      const image = tf.browser
        .fromPixels(bitmap, 3)
        .toFloat()
        .div(255)
        .expandDims(0);
      const activation = model.execute(image, node);
      const pooled = activation.mean([1, 2]);
      return pooled.slice([0, channel], [1, 1]).reshape([]);
    });
    const values = await scalar.data();
    if (!Number.isFinite(values[0]))
      throw new Error("The feature activation is not finite.");
    scalar.dispose();
    scalar = null;
    self.postMessage({
      type: "sample",
      id,
      raw: values[0],
      inferenceMs: performance.now() - started,
      downloadedValues: values.length,
      retainedTensors: tf.memory().numTensors - weightsTensors,
    });
  } finally {
    scalar?.dispose();
    bitmap.close();
    busy = false;
  }
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") await load(data);
    else if (data.type === "observe") await observe(data);
  } catch (error) {
    self.postMessage({
      type: "error",
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
