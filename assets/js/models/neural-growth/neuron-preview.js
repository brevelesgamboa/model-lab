// Differentiable real Fourier image coordinates for the bundled InceptionV3 graph.
// Uses real matrix products so gradients work on TF.js CPU, WebGL and WebGPU.
export const NEURON_PREVIEW_RECIPE = "inception-v3-fourier-v2";
export const NEURON_PREVIEW_SIZE = 96;
export const NEURON_PREVIEW_STEPS = 96;

export function previewSeed(layer, channel, example = 0) {
  let seed = 2166136261;
  for (const character of `${layer}:${channel}:${example}`)
    seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
  return seed >>> 0;
}

export function createFourierImage(tf, size, seed) {
  const basis = new Float32Array(size * size);
  const scales = new Float32Array(size * size);
  const frequency = (index) => Math.floor((index + 1) / 2);
  for (let x = 0; x < size; x += 1) {
    for (let k = 0; k < size; k += 1) {
      const f = frequency(k);
      const phase = (2 * Math.PI * x * f) / size;
      const boundary = k === 0 || (size % 2 === 0 && f === size / 2);
      basis[x * size + k] = boundary
        ? Math.cos(phase) / Math.sqrt(size)
        : Math.sqrt(2 / size) * (k % 2 ? Math.cos(phase) : Math.sin(phase));
      scales[x * size + k] = size / Math.max(1, Math.hypot(frequency(x), f));
    }
  }
  const tensors = tf.tidy(() => ({
    basis: tf.tensor2d(basis, [size, size]),
    transpose: tf.tensor2d(basis, [size, size]).transpose(),
    scales: tf.tensor2d(scales, [size, size]),
    // Lucid maps decorrelated coordinates back to RGB using the transpose.
    // https://github.com/tensorflow/lucid/blob/master/lucid/optvis/param/color.py
    colors: tf
      .tensor2d([
        [0.26, 0.09, 0.02],
        [0.27, 0, -0.05],
        [0.27, -0.09, 0.03],
      ])
      .div(Math.hypot(0.26, 0.27, 0.27))
      .transpose(),
    variable: tf.variable(
      tf.randomNormal([3, size, size], 0, 0.01, "float32", seed),
    ),
  }));
  return {
    variable: tensors.variable,
    render(coefficients) {
      const spatial = tf.matMul(
        tf.matMul(tensors.basis, coefficients.mul(tensors.scales)),
        tensors.transpose,
      );
      return spatial
        .transpose([1, 2, 0])
        .reshape([size * size, 3])
        .matMul(tensors.colors)
        .sigmoid()
        .reshape([1, size, size, 3]);
    },
    dispose() {
      for (const tensor of Object.values(tensors)) tensor.dispose();
    },
  };
}

// Jitter and scale use operations with supported gradients on every app backend.
export function transformPreview(tf, image, size, step, seed) {
  const padding = Math.min(8, size - 1);
  const random = (salt) => {
    let value = (seed ^ Math.imul(step + 1, 1664525) ^ salt) >>> 0;
    value = Math.imul(value ^ (value >>> 16), 2246822507);
    return ((value ^ (value >>> 13)) >>> 0) / 4294967296;
  };
  const crop = Math.max(2, Math.round(size * (0.95 + random(47) * 0.1)));
  const maxOffset = size + padding * 2 - crop;
  const y = Math.floor(random(193) * (maxOffset + 1));
  const x = Math.floor(random(389) * (maxOffset + 1));
  const padded = tf.mirrorPad(
    image,
    [
      [0, 0],
      [padding, padding],
      [padding, padding],
      [0, 0],
    ],
    "reflect",
  );
  return tf.image.resizeBilinear(
    padded.slice([0, y, x, 0], [1, crop, crop, 3]),
    [size, size],
  );
}
