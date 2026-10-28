import { ensureTensorFlow } from "../../training/tf-runtime.js";
import { INCEPTION_LAYERS, clampDreamChannel } from "./dream-guidance.js";
import {
  MOTION_GRID_SIZE,
  constrainMotionField,
  motionFieldStats,
} from "./motion-field.js";

// Grid nodes lie at simulation cell centers 0, N/16, ... . Append periodic
// endpoints and use alignCorners=true so TF and the WebGL sampler agree.
export function upsampleMotionField(tf, field, width, height) {
  const n = MOTION_GRID_SIZE;
  const row = tf.concat([field, field.slice([0, 0, 0, 0], [1, n, 1, 2])], 2);
  const periodic = tf.concat(
    [row, row.slice([0, 0, 0, 0], [1, 1, n + 1, 2])],
    1,
  );
  return tf.image
    .resizeBilinear(periodic, [height + 1, width + 1], true)
    .slice([0, 0, 0, 0], [1, height, width, 2]);
}

// Derivative is with respect to displacement, not source colors. The source
// state is held fixed for this local image-warp surrogate; NCA rules stay frozen.
export function warpWithMotion(
  tf,
  image,
  field,
  { stateSize, horizon = 16 } = {},
) {
  const [, height, width] = image.shape;
  const size = stateSize || width;
  const dense = upsampleMotionField(tf, field, width, height);
  const sampler = tf.customGrad((velocity, save) => {
    const x = tf
      .range(0, width)
      .reshape([1, 1, width, 1])
      .tile([1, height, 1, 1])
      .sub(
        velocity
          .slice([0, 0, 0, 0], [1, height, width, 1])
          .mul((horizon * width) / size),
      );
    const y = tf
      .range(0, height)
      .reshape([1, height, 1, 1])
      .tile([1, 1, width, 1])
      .sub(
        velocity
          .slice([0, 0, 0, 1], [1, height, width, 1])
          .mul((horizon * height) / size),
      );
    const left = x.floor(),
      bottom = y.floor(),
      fx = x.sub(left),
      fy = y.sub(bottom);
    const flat = image.reshape([height * width, 3]);
    const sample = (dx, dy) => {
      const index = bottom
        .add(dy)
        .mod(height)
        .mul(width)
        .add(left.add(dx).mod(width))
        .toInt()
        .reshape([height * width]);
      return tf.gather(flat, index).reshape([1, height, width, 3]);
    };
    const a = sample(0, 0),
      b = sample(1, 0),
      c = sample(0, 1),
      d = sample(1, 1);
    const lower = a.add(b.sub(a).mul(fx)),
      upper = c.add(d.sub(c).mul(fx));
    const value = lower.add(upper.sub(lower).mul(fy));
    const horizontal = b.sub(a).mul(tf.scalar(1).sub(fy)).add(d.sub(c).mul(fy));
    const vertical = upper.sub(lower);
    // At zero initialization the sampler lies on interpolation knots. A
    // symmetric subgradient avoids favoring one side of every pixel boundary.
    const centralX = b
      .sub(sample(-1, 0))
      .mul(tf.scalar(1).sub(fy))
      .add(d.sub(sample(-1, 1)).mul(fy))
      .mul(0.5);
    const centralY = c
      .sub(sample(0, -1))
      .mul(tf.scalar(1).sub(fx))
      .add(d.sub(sample(1, -1)).mul(fx))
      .mul(0.5);
    save([
      tf.where(fx.abs().less(1e-6), centralX, horizontal),
      tf.where(fy.abs().less(1e-6), centralY, vertical),
    ]);
    return {
      value,
      gradFunc: (gradient, saved) =>
        tf.concat(
          [
            gradient
              .mul(saved[0])
              .sum(3, true)
              .mul((-horizon * width) / size),
            gradient
              .mul(saved[1])
              .sum(3, true)
              .mul((-horizon * height) / size),
          ],
          3,
        ),
    };
  });
  return sampler(dense);
}

export function motionImage(tf, bytes, width, height) {
  const values = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++)
    for (let c = 0; c < 3; c++)
      values[i * 3 + c] = ((bytes[i * 4 + c] - 127) * 2) / 255 + 0.5;
  // Clamp after the warp, matching encoded-state transport followed by display.
  return tf.tensor4d(values, [1, height, width, 3]);
}

export function motionFeatureScore(tf, model, image, layer, channel) {
  const raw = model.execute(image.clipByValue(0, 1), INCEPTION_LAYERS[layer]);
  const activation = Array.isArray(raw) ? raw[0] : raw;
  return activation.slice([0, 0, 0, channel], [-1, -1, -1, 1]).mean();
}

export class InceptionMotionController {
  constructor({
    getInceptionModel,
    getTensorFlow = ensureTensorFlow,
    onReset = null,
    layer = "Conv2d_4a_3x3",
    channel = 0,
    learningRate = 0.003,
    momentum = 0.9,
    horizon = 16,
  } = {}) {
    this.getInceptionModel = getInceptionModel;
    this.getTensorFlow = getTensorFlow;
    this.onReset = onReset;
    this.learningRate = learningRate;
    this.momentum = momentum;
    this.horizon = horizon;
    this.field = new Float32Array(MOTION_GRID_SIZE ** 2 * 2);
    this.history = new Float32Array(this.field.length);
    this.sequence = 0;
    this.busy = false;
    this.disposed = false;
    this.setTarget(layer, channel);
  }
  reset() {
    this.sequence++;
    this.field.fill(0);
    this.history.fill(0);
    this.lastUpdate = null;
    this.onReset?.();
  }
  setTarget(layer, channel) {
    if (!Object.hasOwn(INCEPTION_LAYERS, layer))
      throw new RangeError("Unknown Inception motion layer.");
    const selected = clampDreamChannel(channel, layer);
    if (selected < 0)
      throw new RangeError("Motion requires an isolated target channel.");
    if (layer !== this.layer || selected !== this.channel) {
      this.layer = layer;
      this.channel = selected;
      this.reset();
    }
  }
  async update(bytes, width, height, { stateSize = width } = {}) {
    if (this.busy || this.disposed) return null;
    this.busy = true;
    const sequence = ++this.sequence,
      layer = this.layer,
      channel = this.channel;
    const stale = () => this.disposed || sequence !== this.sequence;
    const started = performance.now();
    try {
      const source = await this.getInceptionModel?.();
      const model = source?.execute
        ? source
        : source?.model || (await source?.ensureModel?.());
      if (!model || stale()) return null;
      const tf = await this.getTensorFlow();
      if (stale()) return null;
      const result = tf.tidy(() => {
        const image = motionImage(tf, bytes, width, height);
        const parameters = tf.tensor4d(this.field, [
          1,
          MOTION_GRID_SIZE,
          MOTION_GRID_SIZE,
          2,
        ]);
        return tf.valueAndGrad((candidate) =>
          motionFeatureScore(
            tf,
            model,
            warpWithMotion(tf, image, candidate, {
              stateSize,
              horizon: this.horizon,
            }),
            layer,
            channel,
          ),
        )(parameters);
      });
      let values, score;
      try {
        [values, score] = await Promise.all([
          result.grad.data(),
          result.value.data(),
        ]);
      } finally {
        result.grad.dispose();
        result.value.dispose();
      }
      if (stale()) return null;
      if (
        !Number.isFinite(score[0]) ||
        values.some((value) => !Number.isFinite(value))
      )
        throw new Error("Non-finite displacement gradient.");
      const rms = Math.sqrt(
        values.reduce((sum, value) => sum + value * value, 0) / values.length,
      );
      const direction = constrainMotionField(values);
      const directionRms = motionFieldStats(direction).rmsSpeed;
      const nextHistory = new Float32Array(values.length);
      const candidate = new Float32Array(values.length);
      for (let i = 0; i < values.length; i++) {
        nextHistory[i] =
          this.momentum * this.history[i] +
          ((1 - this.momentum) * direction[i]) / Math.max(directionRms, 1e-8);
        candidate[i] = this.field[i] + this.learningRate * nextHistory[i];
      }
      let proposal = constrainMotionField(candidate, this.field);
      const evaluate = (field) =>
        tf.tidy(() => {
          const image = motionImage(tf, bytes, width, height);
          return motionFeatureScore(
            tf,
            model,
            warpWithMotion(
              tf,
              image,
              tf.tensor4d(field, [1, MOTION_GRID_SIZE, MOTION_GRID_SIZE, 2]),
              { stateSize, horizon: this.horizon },
            ),
            layer,
            channel,
          ).dataSync()[0];
        });
      let after = evaluate(proposal);
      for (let attempt = 0; attempt < 2 && after < score[0] - 1e-6; attempt++) {
        for (let i = 0; i < proposal.length; i++)
          proposal[i] = (proposal[i] + this.field[i]) / 2;
        after = evaluate(proposal);
      }
      const accepted = after >= score[0] - 1e-6;
      if (accepted) {
        this.field = proposal;
        this.history = nextHistory;
      } else this.history.fill(0);
      this.lastUpdate = {
        layer,
        channel,
        scoreBefore: score[0],
        scoreAfter: accepted ? after : score[0],
        gradientRms: rms,
        projectedGradientRms: directionRms,
        accepted,
        elapsedMs: performance.now() - started,
        ...motionFieldStats(this.field),
      };
      return { field: this.field.slice(), ...this.lastUpdate };
    } finally {
      this.busy = false;
    }
  }
  dispose() {
    this.reset();
    this.disposed = true;
  }
}
