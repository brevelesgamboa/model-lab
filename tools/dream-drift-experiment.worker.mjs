// Served only by the experiment runner's browser route. Uses the application's
// actual optimizer with a smaller step; application worker defaults stay intact.
self.onmessage = async ({ data }) => {
  const { bitmap, runtimeUrl, modelUrl, node, channel, iterations, stepSize } =
    data;
  let model, seed;
  try {
    if (!Number.isFinite(stepSize) || stepSize <= 0 || stepSize > 0.04)
      throw new Error(
        "Experimental step size must be positive and at most 0.04.",
      );
    const { loadInceptionForward } =
      await import("/assets/js/models/neural-growth/inception-forward-loader.js");
    const { optimizeDomeDream } =
      await import("/assets/js/models/dome-dream-optimizer.js");
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
      stepSize,
      photoRect: null,
      colorRetention: 1,
      onProgress: (percent) => self.postMessage({ type: "progress", percent }),
    });
    seed.dispose();
    seed = null;
    model.dispose();
    model = null;
    self.postMessage(
      {
        type: "result",
        ...result,
        stepSize,
        backend: tf.getBackend(),
        retainedTensors: tf.memory().numTensors,
      },
      [result.rgba.buffer],
    );
  } catch (error) {
    self.postMessage({ type: "error", error: error.message || String(error) });
  } finally {
    seed?.dispose();
    model?.dispose();
    bitmap.close();
    self.close();
  }
};
