// One-shot, pure forward inference. No gradient tape or activation ascent.
self.onmessage = async ({ data }) => {
  const { bitmap, runtimeUrl, modelUrl, node, channel } = data;
  let model, normalized;
  try {
    self.postMessage({
      type: "status",
      message: "Loading Inception feature map…",
    });
    const { loadInceptionForward } =
      await import("./neural-growth/inception-forward-loader.js");
    const loaded = await loadInceptionForward({ runtimeUrl, modelUrl });
    const { tf } = loaded;
    model = loaded.model;
    const started = performance.now();
    let width, height;
    normalized = tf.tidy(() => {
      // This graph includes its own [-1, 1] normalization after its [0, 1] input.
      const image = tf.browser
        .fromPixels(bitmap, 3)
        .toFloat()
        .div(255)
        .expandDims(0);
      const activation = model.execute(image, node);
      [, height, width] = activation.shape;
      const selected = activation
        .slice([0, 0, 0, channel], [1, height, width, 1])
        .reshape([height, width]);
      const low = selected.min();
      const range = selected.max().sub(low).maximum(1e-6);
      return selected.sub(low).div(range).clipByValue(0, 1);
    });
    const values = new Float32Array(await normalized.data());
    if (!values.every(Number.isFinite))
      throw new Error("Non-finite activation map.");
    normalized.dispose();
    normalized = null;
    model.dispose();
    model = null;
    bitmap.close();
    self.postMessage(
      {
        type: "result",
        width,
        height,
        values,
        inferenceMs: performance.now() - started,
        backend: tf.getBackend(),
        retainedTensors: tf.memory().numTensors,
      },
      [values.buffer],
    );
  } catch (error) {
    normalized?.dispose();
    model?.dispose();
    bitmap.close();
    self.postMessage({ type: "error", error: error.message || String(error) });
  } finally {
    self.close();
  }
};
