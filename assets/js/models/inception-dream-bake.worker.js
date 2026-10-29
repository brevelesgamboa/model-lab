self.onmessage = async ({ data }) => {
  const { bitmap, runtimeUrl, modelUrl, node, channel, iterations, photoRect } =
    data;
  let model, seed;
  try {
    const { loadInceptionForward } =
      await import("./neural-growth/inception-forward-loader.js");
    const { optimizeDomeDream } = await import("./dome-dream-optimizer.js");
    self.postMessage({
      type: "progress",
      percent: 0,
      message: "Loading Inception…",
    });
    const loaded = await loadInceptionForward({ runtimeUrl, modelUrl });
    const { tf } = loaded;
    model = loaded.model;
    seed = tf.tidy(() =>
      tf.browser.fromPixels(bitmap, 3).toFloat().div(255).expandDims(0),
    );
    const result = await optimizeDomeDream(tf, model, seed, {
      node,
      channel,
      iterations,
      photoRect,
      onProgress: (percent) => self.postMessage({ type: "progress", percent }),
    });
    seed.dispose();
    seed = null;
    model.dispose();
    model = null;
    bitmap.close();
    self.postMessage(
      {
        type: "result",
        ...result,
        backend: tf.getBackend(),
        retainedTensors: tf.memory().numTensors,
      },
      [result.rgba.buffer],
    );
  } catch (error) {
    seed?.dispose();
    model?.dispose();
    bitmap.close();
    self.postMessage({ type: "error", error: error.message || String(error) });
  } finally {
    self.close();
  }
};
