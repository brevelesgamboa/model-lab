// A travel session keeps its compiled graph; one-shot bakes still release it.
let loaded;
self.onmessage = async ({ data }) => {
  const {
    bitmap,
    runtimeUrl,
    modelUrl,
    node,
    channel,
    iterations,
    photoRect,
    colorRetention,
    stepSize,
    preserveDetail,
    keepAlive = false,
  } = data;
  let seed;
  try {
    const { loadInceptionForward } =
      await import("./neural-growth/inception-forward-loader.js");
    const { optimizeDomeDream } = await import("./dome-dream-optimizer.js");
    if (!loaded) {
      self.postMessage({
        type: "progress",
        percent: 0,
        message: "Loading Inception…",
      });
      loaded = await loadInceptionForward({ runtimeUrl, modelUrl });
      loaded.modelTensors = loaded.tf.memory().numTensors;
    }
    const { tf, model } = loaded;
    const modelTensors = loaded.modelTensors;
    seed = tf.tidy(() =>
      tf.browser.fromPixels(bitmap, 3).toFloat().div(255).expandDims(0),
    );
    const result = await optimizeDomeDream(tf, model, seed, {
      node,
      channel,
      iterations,
      photoRect,
      colorRetention,
      stepSize,
      preserveDetail,
      onProgress: (percent) => self.postMessage({ type: "progress", percent }),
    });
    seed.dispose();
    seed = null;
    if (!keepAlive) {
      model.dispose();
      loaded = null;
    }
    self.postMessage(
      {
        type: "result",
        ...result,
        backend: tf.getBackend(),
        modelTensors: keepAlive ? modelTensors : 0,
        retainedTensors:
          tf.memory().numTensors - (keepAlive ? modelTensors : 0),
      },
      [result.rgba.buffer],
    );
    if (!keepAlive) self.close();
  } catch (error) {
    seed?.dispose();
    loaded?.model.dispose();
    loaded = null;
    self.postMessage({ type: "error", error: error.message || String(error) });
    self.close();
  } finally {
    bitmap.close();
  }
};
