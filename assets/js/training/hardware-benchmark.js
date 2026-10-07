import { ensureTensorFlow } from "./tf-runtime.js";

const BACKEND_ORDER = ["webgl", "cpu"];

async function activateBackend(tf, backend) {
  try {
    if (!tf.findBackend(backend)) return false;
    const changed = await tf.setBackend(backend);
    await tf.ready();
    return changed !== false && tf.getBackend() === backend;
  } catch (error) {
    console.warn(
      `TensorFlow.js backend ${backend} could not be activated.`,
      error,
    );
    return false;
  }
}

async function timeConvPass(tf) {
  const input = tf.randomUniform([1, 128, 128, 8]);
  const filter = tf.randomUniform([3, 3, 8, 16]);

  try {
    for (let index = 0; index < 2; index += 1) {
      const warm = tf.tidy(() => tf.conv2d(input, filter, 1, "same").relu());
      await warm.data();
      warm.dispose();
    }

    const iterations = 6;
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      const result = tf.tidy(() => tf.conv2d(input, filter, 1, "same").relu());
      await result.data();
      result.dispose();
      await tf.nextFrame();
    }
    return (performance.now() - started) / iterations;
  } finally {
    input.dispose();
    filter.dispose();
  }
}

function classify(backend, milliseconds) {
  if (backend === "webgl") {
    if (milliseconds <= 25)
      return { speedClass: "FAST", recommendedQuality: "high" };
    if (milliseconds <= 55)
      return { speedClass: "BALANCED", recommendedQuality: "pca" };
    return { speedClass: "LIMITED", recommendedQuality: "fast" };
  }

  if (milliseconds <= 55)
    return { speedClass: "BALANCED CPU", recommendedQuality: "fast" };
  return { speedClass: "CPU FALLBACK", recommendedQuality: "fast" };
}

export async function benchmarkTrainingHardware({ onStatus } = {}) {
  const tf = await ensureTensorFlow();
  onStatus?.("CHECKING TENSORFLOW.JS BACKENDS");

  let selected = null;
  for (const backend of BACKEND_ORDER) {
    if (await activateBackend(tf, backend)) {
      selected = backend;
      break;
    }
  }

  if (!selected)
    throw new Error("No supported TensorFlow.js backend is available.");

  onStatus?.(`BENCHMARKING ${selected.toUpperCase()}`);
  const millisecondsPerPass = await timeConvPass(tf);
  const classification = classify(selected, millisecondsPerPass);

  return {
    backend: selected,
    accelerated: selected === "webgl",
    millisecondsPerPass,
    speedClass: classification.speedClass,
    recommendedQuality: classification.recommendedQuality,
    memory: typeof tf.memory === "function" ? tf.memory() : null,
  };
}
