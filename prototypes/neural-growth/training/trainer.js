// Development-only, from-scratch training for the production RGBA8 NCA profile.
// No reference checkpoint or pretrained image network is used.
import {
  CHANNELS,
  PROFILE,
  createRandom,
  createSparseLayout,
  validateCheckpoint,
} from "../../../assets/js/models/neural-growth/reference.js";

const FILTERS = [
  [0, 0, 0, 0, 8, 0, 0, 0, 0],
  [-1, 0, 1, -2, 0, 2, -1, 0, 1],
  [-1, -2, -1, 0, 0, 0, 1, 2, 1],
  [1, 2, 1, 2, -12, 2, 1, 2, 1],
];
const SCALES = [4, 2];

export function createTrainer(
  tf,
  image,
  {
    seed = 20261006,
    size = 32,
    id = "membrane-field",
    name = "Membrane Field",
    spatial = false,
  } = {},
) {
  const random = createRandom(seed);
  const shape = [1, size, size, CHANNELS];
  const quantize = tf.customGrad((input) => ({
    value: input.add(0.5).floor(),
    gradFunc: (gradient) => gradient,
  }));
  const quant = (input, range, center = 127) =>
    quantize(input.div(range).mul(255).add(center).clipByValue(0, 255))
      .sub(center)
      .div(255)
      .mul(range);
  const periodicPad = (input) => {
    const [batch, height, width, channels] = input.shape;
    const rows = tf.concat(
      [
        input.slice([0, height - 1, 0, 0], [batch, 1, width, channels]),
        input,
        input.slice([0, 0, 0, 0], [batch, 1, width, channels]),
      ],
      1,
    );
    return tf.concat(
      [
        rows.slice([0, 0, width - 1, 0], [batch, height + 2, 1, channels]),
        rows,
        rows.slice([0, 0, 0, 0], [batch, height + 2, 1, channels]),
      ],
      2,
    );
  };
  const filterBytes = [];
  for (let pixel = 0; pixel < 9; pixel += 1)
    for (let channel = 0; channel < CHANNELS; channel += 1)
      for (const filter of FILTERS) filterBytes.push(filter[pixel] / 8);
  const filters = tf.tensor4d(filterBytes, [3, 3, CHANNELS, 4]);
  const variables = tf.tidy(() => [
    tf.variable(tf.randomNormal([49, 96], 0, 0.22, "float32", seed)),
    tf.variable(
      tf.concat(
        [
          tf.zeros([96, 12]),
          tf.randomNormal([1, 12], 0, 0.025, "float32", seed + 1),
        ],
        0,
      ),
    ),
  ]);
  const optimizer = tf.train.adam(0.001);
  const featureKernel = tf.randomNormal([3, 3, 3, 32], 0, 0.2, "float32", 71);
  const featureBias = tf.randomNormal([32], 0, 0.15, "float32", 72);
  const descriptor = (rgb) => {
    const statistics = [];
    let level = rgb;
    for (let scale = 0; scale < 4; scale += 1) {
      const features = tf
        .conv2d(periodicPad(level), featureKernel, 1, "valid")
        .add(featureBias)
        .relu();
      const flat = features.reshape([features.shape[0], -1, 32]);
      statistics.push(
        tf.matMul(flat, flat, true, false).div(flat.shape[1]),
        level.mean([1, 2]),
        level.square().mean([1, 2]),
      );
      if (spatial) {
        const [batch, height, width] = level.shape;
        const rgbFlat = level.reshape([batch, -1, 3]);
        const shiftX = tf.concat(
          [
            level.slice([0, 0, 1, 0], [batch, height, width - 1, 3]),
            level.slice([0, 0, 0, 0], [batch, height, 1, 3]),
          ],
          2,
        );
        const shiftY = tf.concat(
          [
            level.slice([0, 1, 0, 0], [batch, height - 1, width, 3]),
            level.slice([0, 0, 0, 0], [batch, 1, width, 3]),
          ],
          1,
        );
        statistics.push(
          tf.matMul(rgbFlat, rgbFlat, true, false).div(rgbFlat.shape[1]),
          level.sub(shiftX).square().mean([1, 2]),
          level.sub(shiftY).square().mean([1, 2]),
        );
      }
      if (scale < 3) level = tf.avgPool(level, 2, 2, "valid");
    }
    return statistics;
  };
  const target = tf.tidy(() =>
    descriptor(
      tf.browser.fromPixels(image).toFloat().div(127.5).sub(1).expandDims(),
    ),
  );
  const normalization = target.map((statistic, index) =>
    tf.tidy(() =>
      statistic
        .square()
        .mean()
        .add(spatial && index % 6 >= 3 ? 0.003 : 0.03),
    ),
  );
  const lossFor = (state) => {
    const rgb = state.slice([0, 0, 0, 0], [-1, -1, -1, 3]).clipByValue(-1, 1);
    const actual = descriptor(rgb);
    const terms = actual.map((statistic, index) =>
      statistic.sub(target[index]).square().mean().div(normalization[index]),
    );
    return tf
      .addN(terms)
      .div(terms.length)
      .add(state.abs().sub(1.7).relu().square().mean().mul(0.01));
  };
  const perceive = (state) => {
    const [batch, height, width] = state.shape;
    return quant(
      tf
        .depthwiseConv2d(periodicPad(state), filters, 1, "valid")
        .reshape([batch, height, width, CHANNELS, 4])
        .transpose([0, 1, 2, 4, 3])
        .reshape([batch, height, width, 48]),
      4,
    );
  };
  const dense = (input, weights, scale, hidden) => {
    const rows = weights.shape[0] - 1;
    const columns = weights.shape[1];
    const values = quant(weights, scale).div(scale);
    const output = tf
      .matMul(input.reshape([-1, rows]), values.slice([0, 0], [rows, columns]))
      .add(values.slice([rows, 0], [1, columns]))
      .mul(scale);
    return quant(output, hidden ? 2 : 4, hidden ? 0 : 127).reshape([
      ...input.shape.slice(0, 3),
      columns,
    ]);
  };
  const step = (state, mask) => {
    const hidden = dense(perceive(state), variables[0], SCALES[0], true);
    const delta = dense(hidden, variables[1], SCALES[1], false);
    return quant(state.add(delta.mul(mask)), 4);
  };
  const pool = Array.from({ length: 32 }, () => tf.zeros(shape));
  const layouts = Array.from({ length: 2 }, (_, index) =>
    createSparseLayout(size, seed + index),
  );
  let iteration = 0;
  let lastLoss = null;
  let disposed = false;

  const makeMask = () => {
    const data = new Float32Array(2 * size * size);
    for (let batch = 0; batch < 2; batch += 1) {
      const layout = layouts[batch];
      const dx = Math.floor(layout.random() * size);
      const dy = Math.floor(layout.random() * size);
      for (let y = 0; y < size; y += 1)
        for (let x = 0; x < size; x += 1)
          data[batch * size * size + y * size + x] = layout.inverse[
            (((y - dy + size) % size) * size + ((x - dx + size) % size)) * 4 + 2
          ]
            ? 1
            : 0;
    }
    return tf.tensor4d(data, [2, size, size, 1]);
  };
  const damage = (state) =>
    tf.tidy(() => {
      const cx = Math.floor(random() * size);
      const cy = Math.floor(random() * size);
      const radius = size * (0.08 + random() * 0.12);
      const mask = new Float32Array(size * size);
      for (let y = 0; y < size; y += 1)
        for (let x = 0; x < size; x += 1) {
          const dx = Math.min(Math.abs(x - cx), size - Math.abs(x - cx));
          const dy = Math.min(Math.abs(y - cy), size - Math.abs(y - cy));
          mask[y * size + x] = Math.hypot(dx, dy) > radius ? 1 : 0;
        }
      return state.mul(tf.tensor4d(mask, [1, size, size, 1]));
    });
  return {
    variables,
    step,
    quant,
    lossFor,
    async trainIteration() {
      if (disposed) throw new Error("Trainer has been disposed.");
      const first = Math.floor(random() * pool.length);
      const second =
        (first + 1 + Math.floor(random() * (pool.length - 1))) % pool.length;
      const unroll = 24 + Math.floor(random() * 17);
      let finalState;
      const result = tf.tidy(() => {
        const initial = iteration % 8 === 0 ? tf.zeros(shape) : pool[first];
        const other = iteration % 4 === 0 ? damage(pool[second]) : pool[second];
        const { value, grads } = tf.variableGrads(() => {
          let state = tf.concat([initial, other], 0);
          for (let index = 0; index < unroll; index += 1)
            state = step(state, makeMask());
          finalState = tf.keep(state);
          return lossFor(state);
        }, variables);
        const norm = tf
          .addN(Object.values(grads).map((gradient) => gradient.square().sum()))
          .sqrt()
          .add(1e-8);
        const clipped = Object.fromEntries(
          Object.entries(grads).map(([name, gradient]) => [
            name,
            gradient.div(norm.maximum(1)),
          ]),
        );
        optimizer.applyGradients(clipped);
        for (let index = 0; index < variables.length; index += 1)
          variables[index].assign(
            variables[index].clipByValue(
              (-127 * SCALES[index]) / 255,
              (128 * SCALES[index]) / 255,
            ),
          );
        return value;
      });
      try {
        lastLoss = (await result.data())[0];
        if (!Number.isFinite(lastLoss))
          throw new Error("Training loss is not finite.");
        const states = tf.split(finalState, 2, 0);
        pool[first].dispose();
        pool[second].dispose();
        [pool[first], pool[second]] = states;
        iteration += 1;
        return {
          iteration,
          loss: lastLoss,
          unroll,
          tensors: tf.memory().numTensors,
        };
      } finally {
        result.dispose();
        finalState?.dispose();
      }
    },
    async checkpoint() {
      const layers = [];
      // Snapshot both layers together before asynchronous GPU readback. A live
      // training iteration must not produce an export with mixed weight ages.
      const snapshots = variables.map((variable) => variable.clone());
      try {
        for (let index = 0; index < snapshots.length; index += 1) {
          const values = await snapshots[index].data();
          layers.push({
            shape: snapshots[index].shape,
            scale: SCALES[index],
            weights: Array.from(values, (value) =>
              Math.max(
                0,
                Math.min(
                  255,
                  Math.floor((value / SCALES[index]) * 255 + 127.5),
                ),
              ),
            ),
          });
        }
      } finally {
        for (const snapshot of snapshots) snapshot.dispose();
      }
      const checkpoint = {
        format: PROFILE,
        id,
        name,
        layers,
      };
      validateCheckpoint(checkpoint);
      return {
        checkpoint,
        training: {
          seed,
          size,
          iteration,
          loss: lastLoss,
          objective: spatial
            ? "multiscale-fixed-feature-spatial-v2"
            : "multiscale-fixed-feature-gram-v1",
          weightScales: SCALES,
        },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const tensor of [
        ...variables,
        ...pool,
        ...target,
        ...normalization,
        filters,
        featureKernel,
        featureBias,
      ])
        tensor.dispose();
      optimizer.dispose();
    },
  };
}
