/*
 * SPDX-License-Identifier: MIT
 * Live Inception Perceptual Guidance Bridge for Texture NCA.
 * Connects TensorFlow.js InceptionV3 feature ascent into the WebGL2 NCA runtime.
 */
import { ensureTensorFlow } from "../../training/tf-runtime.js";
import { calcTvLoss } from "../inception-dream.js";

// TensorFlow Slim InceptionV3 endpoint depths (depth_multiplier = 1).
// https://github.com/tensorflow/models/blob/master/research/slim/nets/inception_v3.py
export const INCEPTION_LAYER_CHANNELS = Object.freeze({
  mixed_5b: 256,
  mixed_5c: 288,
  mixed_5d: 288,
  mixed_6a: 768,
  mixed_6b: 768,
  mixed_6c: 768,
  mixed_6d: 768,
  mixed_6e: 768,
  mixed_7a: 1280,
  mixed_7b: 2048,
  mixed_7c: 2048,
});

export function getInceptionLayerChannels(layer) {
  return Object.hasOwn(INCEPTION_LAYER_CHANNELS, layer)
    ? INCEPTION_LAYER_CHANNELS[layer]
    : INCEPTION_LAYER_CHANNELS.mixed_6c;
}

export function clampDreamChannel(channel, layer = "mixed_6c") {
  const value = Math.round(Number(channel));
  const channels = getInceptionLayerChannels(layer);
  return Number.isFinite(value)
    ? Math.max(-1, Math.min(value, channels - 1))
    : -1;
}

export const INCEPTION_LAYERS = Object.freeze({
  mixed_5b: "module_apply_default/InceptionV3/InceptionV3/Mixed_5b/concat",
  mixed_5c: "module_apply_default/InceptionV3/InceptionV3/Mixed_5c/concat",
  mixed_5d: "module_apply_default/InceptionV3/InceptionV3/Mixed_5d/concat",
  mixed_6a: "module_apply_default/InceptionV3/InceptionV3/Mixed_6a/concat",
  mixed_6b: "module_apply_default/InceptionV3/InceptionV3/Mixed_6b/concat",
  mixed_6c: "module_apply_default/InceptionV3/InceptionV3/Mixed_6c/concat",
  mixed_6d: "module_apply_default/InceptionV3/InceptionV3/Mixed_6d/concat",
  mixed_6e: "module_apply_default/InceptionV3/InceptionV3/Mixed_6e/concat",
  mixed_7a: "module_apply_default/InceptionV3/InceptionV3/Mixed_7a/concat",
  mixed_7b: "module_apply_default/InceptionV3/InceptionV3/Mixed_7b/concat",
  mixed_7c: "module_apply_default/InceptionV3/InceptionV3/Mixed_7c/concat",
});

export const DREAM_GUIDANCE_DEFAULTS = Object.freeze({
  enabled: "off",
  strength: 0.0,
  cadence: 8,
  targetLayer: "mixed_6c",
  targetChannel: -1,
  jitter: true,
  tvWeight: 0.005,
  chroma: 0.0,
  resolution: 192,
});

function previewDelay(signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, 16);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Optimize RGB pixels in memory; no simulation state or image files are used. */
export async function generateNeuronPreview(
  model, layerName, channelIndex, size = 64, steps = 30,
  { signal, beforeStep = () => previewDelay(signal) } = {},
) {
  if (!Number.isInteger(size) || size < 2 || !Number.isInteger(steps) || steps < 1) {
    throw new RangeError("Preview size and steps must be positive integers (size >= 2).");
  }
  signal?.throwIfAborted();
  const tf = globalThis.tf || await ensureTensorFlow();
  await tf.ready();
  const nodeName = INCEPTION_LAYERS[layerName] || layerName;
  // This bundled TF Hub graph accepts [0, 1] and contains its own Mul/Sub.
  // Bare Inception graphs still receive the conventional [-1, 1] input.
  const internalPreprocessing = Boolean(
    model.executor?.graph?.nodes?.["module_apply_default/hub_input/Sub"],
  );
  // Valid-padding reduction blocks need at least 75px to reach Mixed_7b/7c.
  const inferenceSize = Math.max(96, size);
  let img = null;
  let pixels = null;
  try {
    img = tf.tidy(() => tf.variable(tf.randomUniform([1, size, size, 3], 0.4, 0.6)));
    const valueAndGrad = tf.valueAndGrad((input) => {
      const resized = size === inferenceSize ? input : tf.image.resizeBilinear(input, [inferenceSize, inferenceSize]);
      const raw = model.execute(internalPreprocessing ? resized : resized.mul(2).sub(1), nodeName);
      const act = Array.isArray(raw) ? raw[0] : raw;
      const safeCh = Math.max(0, Math.min(Math.floor(channelIndex), act.shape[3] - 1));
      const feature = channelIndex < 0
        ? act.square().mean().add(1e-8).sqrt()
        : act.slice([0, 0, 0, safeCh], [-1, -1, -1, 1]).mean();
      return feature.sub(calcTvLoss(tf, input).mul(0.005));
    });
    for (let step = 0; step < steps; step += 1) {
      await beforeStep();
      signal?.throwIfAborted();
      const fence = tf.tidy(() => {
        const engine = tf.engine();
        const ownsTape = engine.state.gradientDepth === 0;
        try {
          const { grad } = valueAndGrad(img);
          const std = tf.moments(grad).variance.sqrt().add(1e-6);
          img.assign(img.add(grad.div(std).mul(0.06)).clipByValue(0, 1));
          // Read a scalar after assignment so GPU work cannot accumulate while yielding.
          return img.mean();
        } catch (error) {
          // TF.js 4.22 retains kept tape tensors when a gradient throws.
          // Only this synchronous, non-nested step owns the tape being freed.
          if (ownsTape && engine.state.gradientDepth === 0) {
            for (const node of engine.state.activeTape || []) tf.dispose(node.saved);
            engine.state.activeTape = null;
          }
          throw error;
        }
      });
      try {
        const [mean] = await fence.data();
        if (!Number.isFinite(mean)) throw new Error("Preview optimization produced non-finite pixels.");
      } finally {
        fence.dispose();
      }
    }
    signal?.throwIfAborted();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    pixels = img.squeeze([0]);
    await tf.browser.toPixels(pixels, canvas);
    signal?.throwIfAborted();
    return canvas.toDataURL("image/webp", 0.85);
  } finally {
    pixels?.dispose();
    img?.dispose();
  }
}

/**
 * Converts encoded state phenotype bytes into a normalized Float32 RGB buffer [0, 1]
 * with optional circular spatial translation (dx, dy).
 */
export function phenotypeBytesToFloatRgb(bytes, width, height, dx = 0, dy = 0) {
  const pixelCount = width * height;
  const floatRgb = new Float32Array(pixelCount * 3);
  const shiftX = Math.round(dx) || 0;
  const shiftY = Math.round(dy) || 0;
  if (shiftX === 0 && shiftY === 0) {
    for (let i = 0, j = 0; i < pixelCount * 4; i += 4, j += 3) {
      // Raw byte b in [0, 255] maps via decodeState and phenotype RGB formula:
      // cell = (b - 127) / 255 * 4
      // rgb = clamp(cell * 0.5 + 0.5, 0, 1) = clamp((b - 127) * (2 / 255) + 0.5, 0, 1)
      const r = (bytes[i] - 127) * (2 / 255) + 0.5;
      const g = (bytes[i + 1] - 127) * (2 / 255) + 0.5;
      const b = (bytes[i + 2] - 127) * (2 / 255) + 0.5;
      floatRgb[j] = r < 0 ? 0 : r > 1 ? 1 : r;
      floatRgb[j + 1] = g < 0 ? 0 : g > 1 ? 1 : g;
      floatRgb[j + 2] = b < 0 ? 0 : b > 1 ? 1 : b;
    }
    return floatRgb;
  }
  for (let y = 0; y < height; y++) {
    const sy = ((y - shiftY) % height + height) % height;
    for (let x = 0; x < width; x++) {
      const sx = ((x - shiftX) % width + width) % width;
      const srcIdx = (sy * width + sx) * 4;
      const dstIdx = (y * width + x) * 3;
      const r = (bytes[srcIdx] - 127) * (2 / 255) + 0.5;
      const g = (bytes[srcIdx + 1] - 127) * (2 / 255) + 0.5;
      const b = (bytes[srcIdx + 2] - 127) * (2 / 255) + 0.5;
      floatRgb[dstIdx] = r < 0 ? 0 : r > 1 ? 1 : r;
      floatRgb[dstIdx + 1] = g < 0 ? 0 : g > 1 ? 1 : g;
      floatRgb[dstIdx + 2] = b < 0 ? 0 : b > 1 ? 1 : b;
    }
  }
  return floatRgb;
}

/**
 * Applies a separable 5-tap Gaussian spatial low-pass filter across a 3-channel flat float array.
 * Strips high-frequency checkerboard noise while preserving macro feature contours.
 */
export function applySpatialGradientSmoothing(flatGrad, width, height) {
  if (!flatGrad || width < 5 || height < 5) return flatGrad;
  const pixelCount = width * height;
  const temp = new Float32Array(pixelCount * 3);
  const smoothed = new Float32Array(pixelCount * 3);

  // Horizontal pass: 5-tap kernel [1, 4, 6, 4, 1] / 16 with circular wrapping
  for (let y = 0; y < height; y++) {
    const yOff = y * width;
    for (let x = 0; x < width; x++) {
      const xm2 = ((x - 2) % width + width) % width;
      const xm1 = ((x - 1) % width + width) % width;
      const xp1 = (x + 1) % width;
      const xp2 = (x + 2) % width;
      const di = (yOff + x) * 3;
      const i0 = (yOff + xm2) * 3;
      const i1 = (yOff + xm1) * 3;
      const i2 = di;
      const i3 = (yOff + xp1) * 3;
      const i4 = (yOff + xp2) * 3;
      for (let c = 0; c < 3; c++) {
        temp[di + c] =
          (flatGrad[i0 + c] +
            4 * flatGrad[i1 + c] +
            6 * flatGrad[i2 + c] +
            4 * flatGrad[i3 + c] +
            flatGrad[i4 + c]) *
          0.0625;
      }
    }
  }

  // Vertical pass: 5-tap kernel [1, 4, 6, 4, 1] / 16 with circular wrapping
  for (let y = 0; y < height; y++) {
    const ym2 = (((y - 2) % height + height) % height) * width;
    const ym1 = (((y - 1) % height + height) % height) * width;
    const y0 = y * width;
    const yp1 = ((y + 1) % height) * width;
    const yp2 = ((y + 2) % height) * width;
    for (let x = 0; x < width; x++) {
      const di = (y0 + x) * 3;
      const i0 = (ym2 + x) * 3;
      const i1 = (ym1 + x) * 3;
      const i2 = di;
      const i3 = (yp1 + x) * 3;
      const i4 = (yp2 + x) * 3;
      for (let c = 0; c < 3; c++) {
        smoothed[di + c] =
          (temp[i0 + c] +
            4 * temp[i1 + c] +
            6 * temp[i2 + c] +
            4 * temp[i3 + c] +
            temp[i4 + c]) *
          0.0625;
      }
    }
  }

  return smoothed;
}

/**
 * Converts a 3-channel flat gradient array into RGBA Uint8 bytes centered at 127 (neutral)
 * with optional circular spatial reverse unroll (dx, dy).
 * Accepts both normalized Float32 values in [-1, 1] and direct byte values in [0, 255].
 */
export function gradientDataToRgbaBytes(flatGrad, width, height, dx = 0, dy = 0) {
  const pixelCount = width * height;
  const rgba = new Uint8Array(pixelCount * 4);
  const shiftX = Math.round(dx) || 0;
  const shiftY = Math.round(dy) || 0;
  const isFloat = flatGrad instanceof Float32Array || flatGrad instanceof Float64Array;

  const toByte = (v) => {
    if (isFloat) {
      const clamped = v < -1 ? -1 : v > 1 ? 1 : v;
      return Math.round(clamped * 127.0 + 127.0);
    }
    return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  };

  if (shiftX === 0 && shiftY === 0) {
    for (let i = 0, j = 0; i < pixelCount * 3; i += 3, j += 4) {
      rgba[j] = toByte(flatGrad[i]);
      rgba[j + 1] = toByte(flatGrad[i + 1]);
      rgba[j + 2] = toByte(flatGrad[i + 2]);
      rgba[j + 3] = 255;
    }
    return rgba;
  }
  for (let y = 0; y < height; y++) {
    const gy = ((y + shiftY) % height + height) % height;
    for (let x = 0; x < width; x++) {
      const gx = ((x + shiftX) % width + width) % width;
      const srcIdx = (gy * width + gx) * 3;
      const dstIdx = (y * width + x) * 4;
      rgba[dstIdx] = toByte(flatGrad[srcIdx]);
      rgba[dstIdx + 1] = toByte(flatGrad[srcIdx + 1]);
      rgba[dstIdx + 2] = toByte(flatGrad[srcIdx + 2]);
      rgba[dstIdx + 3] = 255;
    }
  }
  return rgba;
}

export class DreamGuidanceBridge {
  constructor({ getInceptionModel = null, archetypes = [], generatePreview = generateNeuronPreview } = {}) {
    this._getInceptionModel = getInceptionModel;
    this._isBusy = false;
    this._model = null;
    this._loadingPromise = null;
    this._prevGrad = null;
    this.previewCache = new Map();
    this._archetypes = archetypes;
    this._generatePreview = generatePreview;
    this._previewQueue = new Map();
    this._previewAttempts = new Set();
    this._previewListeners = new Set();
    this._previewAbort = new AbortController();
    this._previewTask = null;
    this.disposed = false;
  }

  subscribePreviews(listener) {
    this._previewListeners.add(listener);
    return () => this._previewListeners.delete(listener);
  }

  // Called for both standalone guidance loads and the shared Inception model.
  onModelReady(model) {
    if (this.disposed) return;
    this._model = model;
    void this.warmArchetypePreviews(this._archetypes);
  }

  warmArchetypePreviews(archetypes) {
    if (this.disposed) return Promise.resolve(this.previewCache);
    for (const neuron of archetypes) {
      const key = `${neuron.layer}_${neuron.channel}`;
      if (!this.previewCache.has(key) && !this._previewAttempts.has(key)) {
        this._previewQueue.set(key, neuron);
      }
    }
    if (this._previewTask) return this._previewTask;
    if (!this._previewQueue.size) return Promise.resolve(this.previewCache);
    const signal = this._previewAbort.signal;
    this._previewTask = (async () => {
      // Defer all model/GPU work until the foreground initialization returns.
      await previewDelay(signal);
      const model = await this.ensureModel();
      while (this._previewQueue.size && !signal.aborted) {
        const [key, neuron] = this._previewQueue.entries().next().value;
        this._previewQueue.delete(key);
        this._previewAttempts.add(key);
        try {
          const url = await this._generatePreview(model, neuron.layer, neuron.channel, 96, 30, {
            signal,
            beforeStep: async () => {
              do {
                await previewDelay(signal);
              } while (this._isBusy || this._getInceptionModel?.()?.isRunning || this._getInceptionModel?.()?.isOctaveRunning || globalThis.document?.hidden);
            },
          });
          if (signal.aborted) break;
          this.previewCache.set(key, url);
          for (const listener of this._previewListeners) listener(key, url);
        } catch (error) {
          if (signal.aborted) break;
          // An unavailable channel preview must not affect guidance or other cards.
          console.warn("Neuron preview unavailable:", neuron.id, error);
        }
        await previewDelay(signal);
      }
    })().catch((error) => {
      if (!signal.aborted) console.warn("Neuron previews unavailable:", error);
    }).then(() => this.previewCache).finally(() => { this._previewTask = null; });
    return this._previewTask;
  }

  get isBusy() {
    return this._isBusy;
  }

  async getTensorFlow() {
    if (globalThis.tf) {
      await globalThis.tf.ready?.();
      return globalThis.tf;
    }
    return ensureTensorFlow();
  }

  async ensureModel() {
    if (this._model) return this._model;
    if (this._loadingPromise) return this._loadingPromise;

    this._loadingPromise = (async () => {
      // 1. Try to reuse model from InceptionDreamModel instance if available
      const dreamModel = this._getInceptionModel?.();
      if (dreamModel) {
        if (dreamModel.model) {
          this._model = dreamModel.model;
          return this._model;
        }
        if (typeof dreamModel.ensureModel === "function") {
          const model = await dreamModel.ensureModel();
          this._model = model;
          return this._model;
        }
      }

      // 2. Standalone fallback loader
      const tf = await this.getTensorFlow();
      this._model = await tf.loadGraphModel("./models/inception/model.json", {
        streamWeights: true,
      });
      return this._model;
    })().finally(() => {
      this._loadingPromise = null;
    });

    const model = await this._loadingPromise;
    if (this.disposed) {
      this._model = null;
      return null;
    }
    this.onModelReady(model);
    return model;
  }

  resetMomentum() {
    this._prevGrad = null;
  }

  async computeGradient(
    rgbBytes,
    width = 192,
    height = 192,
    targetLayer = "mixed_6c",
    targetChannel = -1,
    jitter = true,
    tvWeight = 0.005,
  ) {
    if (this._isBusy || this.disposed) return null;
    this._isBusy = true;

    try {
      const model = await this.ensureModel();
      if (!model || this.disposed) return null;

      const tf = await this.getTensorFlow();
      const dx = jitter ? Math.floor(Math.random() * 17) - 8 : 0;
      const dy = jitter ? Math.floor(Math.random() * 17) - 8 : 0;
      const floatRgb = phenotypeBytesToFloatRgb(rgbBytes, width, height, dx, dy);
      const nodeName = INCEPTION_LAYERS[targetLayer] || INCEPTION_LAYERS.mixed_6c;

      const saturatedTensor = tf.tidy(() => {
        const input = tf.tensor4d(floatRgb, [1, height, width, 3]);
        const lossFn = (x) => {
          const raw = model.execute(x, nodeName);
          const act = Array.isArray(raw) ? raw[0] : raw;
          const channelCount = act?.shape?.[3];
          let featureScore;
          if (targetChannel >= 0 && channelCount) {
            // The executing graph is authoritative, even if its shape differs
            // from the layer metadata or the layer changed during inference.
            const maxChannel = act.shape[3] - 1;
            const safeChannel = Math.max(
              0,
              Math.min(Math.floor(targetChannel), maxChannel),
            );
            featureScore = act
              .slice([0, 0, 0, safeChannel], [-1, -1, -1, 1])
              .mean();
          } else {
            featureScore = act.mean();
          }
          if (tvWeight > 0.00001) {
            const tv = calcTvLoss(tf, x);
            return featureScore.sub(tv.mul(tvWeight));
          }
          return featureScore;
        };

        const { value, grad } = tf.valueAndGrad(lossFn)(input);
        value.dispose();

        // Standard-deviation normalized gradient ascent with per-channel centering and tanh saturation
        const moments = tf.moments(grad, [1, 2], true);
        const std = moments.variance.sqrt().add(1e-5);
        const normalized = grad.sub(moments.mean).div(std);
        const saturated = tf.tanh(normalized.mul(1.0));

        return saturated.squeeze([0]); // [height, width, 3] in [-1, 1]
      });

      const rawGrad = await saturatedTensor.data();
      saturatedTensor.dispose();

      // Temporal EMA blending (70% previous gradient momentum + 30% new gradient)
      let blendedGrad;
      if (this._prevGrad && this._prevGrad.length === rawGrad.length) {
        blendedGrad = new Float32Array(rawGrad.length);
        for (let i = 0; i < rawGrad.length; i++) {
          blendedGrad[i] = this._prevGrad[i] * 0.7 + rawGrad[i] * 0.3;
        }
        this._prevGrad.set(blendedGrad);
      } else {
        blendedGrad = new Float32Array(rawGrad);
        this._prevGrad = new Float32Array(rawGrad);
      }

      // Spatial Gaussian low-pass smoothing (5x5 separable blur)
      const smoothedGrad = applySpatialGradientSmoothing(blendedGrad, width, height);

      return gradientDataToRgbaBytes(smoothedGrad, width, height, dx, dy);
    } finally {
      this._isBusy = false;
    }
  }

  dispose() {
    this.disposed = true;
    this._previewAbort.abort();
    this._previewQueue.clear();
    this._previewAttempts.clear();
    this._previewListeners.clear();
    this.previewCache.clear();
    this._model = null;
    this._loadingPromise = null;
    this._prevGrad = null;
  }
}

