/*
 * SPDX-License-Identifier: MIT
 * Live Inception Perceptual Guidance Bridge for Texture NCA.
 * Connects TensorFlow.js InceptionV3 feature ascent into the WebGL2 NCA runtime.
 */
import { ensureTensorFlow } from "../../training/tf-runtime.js";
import { calcTvLoss } from "../inception-dream.js";

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
  constructor({ getInceptionModel = null } = {}) {
    this._getInceptionModel = getInceptionModel;
    this._isBusy = false;
    this._model = null;
    this._loadingPromise = null;
    this._prevGrad = null;
    this.disposed = false;
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

    return this._loadingPromise;
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
            const safeChannel = Math.min(
              Math.max(0, Math.floor(targetChannel)),
              channelCount - 1,
            );
            featureScore = act.slice([0, 0, 0, safeChannel], [-1, -1, -1, 1]).mean();
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
    this._model = null;
    this._loadingPromise = null;
    this._prevGrad = null;
  }
}

