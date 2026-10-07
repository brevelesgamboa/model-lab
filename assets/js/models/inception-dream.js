import { clamp } from "../core/utils.js";
import {
  ensureTensorFlow,
  activateTensorFlowBackend,
} from "../training/tf-runtime.js";

const MODEL_URL = "./models/inception/model.json";
const QUALITY_PIPELINE = "multi_octave_quality";
const PREVIEW_PIPELINE = "multi_octave_preview";

function drawDiagnostic(targetCanvas, title, detail) {
  const context = targetCanvas.getContext("2d", { alpha: false });
  const width = targetCanvas.width;
  const height = targetCanvas.height;
  context.save();
  context.fillStyle = "#050506";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(124,58,237,.35)";
  context.lineWidth = Math.max(1, width / 700);
  context.strokeRect(width * 0.08, height * 0.1, width * 0.84, height * 0.8);
  context.fillStyle = "#f4f1f8";
  context.textAlign = "center";
  context.font = `${Math.max(16, width * 0.025)}px monospace`;
  context.fillText(title, width / 2, height * 0.45);
  context.fillStyle = "#a6a0ad";
  context.font = `${Math.max(11, width * 0.015)}px monospace`;
  const lines = String(detail || "").match(/.{1,56}(?:\s|$)/g) || [];
  lines.slice(0, 4).forEach((line, index) => {
    context.fillText(
      line.trim(),
      width / 2,
      height * 0.52 + index * Math.max(16, width * 0.025),
    );
  });
  context.restore();
}

function drawContain(context, source, width, height) {
  const sw =
    Number(source.width || source.videoWidth || source.naturalWidth) || width;
  const sh =
    Number(source.height || source.videoHeight || source.naturalHeight) ||
    height;
  const scale = Math.min(width / sw, height / sh);
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  context.drawImage(
    source,
    (width - sw * scale) / 2,
    (height - sh * scale) / 2,
    sw * scale,
    sh * scale,
  );
}

export function drawSharpenedContain(
  context,
  dreamSource,
  photoSource,
  width,
  height,
  fusionAlpha = 0.22,
) {
  if (!context || !dreamSource) return;
  const sw =
    Number(dreamSource.width || dreamSource.videoWidth || dreamSource.naturalWidth) ||
    width;
  const sh =
    Number(dreamSource.height || dreamSource.videoHeight || dreamSource.naturalHeight) ||
    height;
  const scale = Math.min(width / sw, height / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  const dx = (width - dw) / 2;
  const dy = (height - dh) / 2;

  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  context.drawImage(dreamSource, dx, dy, dw, dh);

  if (photoSource && Number(fusionAlpha) > 0.001) {
    context.save();
    context.globalCompositeOperation = "soft-light";
    context.globalAlpha = Math.min(0.6, Math.max(0, Number(fusionAlpha)));
    context.drawImage(photoSource, dx, dy, dw, dh);
    context.restore();
  }
}

export function computeTileGrid(targetW, targetH, tileSize = 384, overlap = 64) {
  const actualTileW = Math.min(tileSize, targetW);
  const actualTileH = Math.min(tileSize, targetH);
  const strideX = Math.max(1, actualTileW - overlap);
  const strideY = Math.max(1, actualTileH - overlap);

  function getPositions(total, size, stride) {
    if (total <= size) return [0];
    const coords = [];
    for (let p = 0; p <= total - size; p += stride) {
      coords.push(p);
    }
    if (coords[coords.length - 1] !== total - size) {
      coords.push(total - size);
    }
    return coords;
  }

  const xCoords = getPositions(targetW, actualTileW, strideX);
  const yCoords = getPositions(targetH, actualTileH, strideY);
  const tiles = [];
  for (const y of yCoords) {
    for (const x of xCoords) {
      tiles.push({ x, y, width: actualTileW, height: actualTileH });
    }
  }
  return {
    tileWidth: actualTileW,
    tileHeight: actualTileH,
    xCoords,
    yCoords,
    tiles,
  };
}

export function getHannWeight(u, v, tileW, tileH, gamma = 1.2) {
  const wx = Math.sin(((u + 0.5) * Math.PI) / tileW);
  const wy = Math.sin(((v + 0.5) * Math.PI) / tileH);
  return Math.pow(wx * wy, gamma);
}

function roll2D(tf, tensor, shiftY, shiftX) {
  return tf.tidy(() => {
    const [batch, h, w, c] = tensor.shape;
    let res = tensor;
    const sy = ((shiftY % h) + h) % h;
    if (sy !== 0) {
      const top = tf.slice(res, [0, h - sy, 0, 0], [batch, sy, w, c]);
      const btm = tf.slice(res, [0, 0, 0, 0], [batch, h - sy, w, c]);
      res = tf.concat([top, btm], 1);
    }
    const sx = ((shiftX % w) + w) % w;
    if (sx !== 0) {
      const left = tf.slice(res, [0, 0, w - sx, 0], [batch, h, sx, c]);
      const right = tf.slice(res, [0, 0, 0, 0], [batch, h, w - sx, c]);
      res = tf.concat([left, right], 2);
    }
    return res;
  });
}

function matchSourceColor(tf, dreamTensor, sourceTensor, blend = 0.85) {
  return tf.tidy(() => {
    const [, h, w] = dreamTensor.shape;
    const resizedSource = tf.image.resizeBilinear(sourceTensor, [h, w]);
    const weights = tf.tensor1d([0.299, 0.587, 0.114]).reshape([1, 1, 1, 3]);
    const dreamLum = tf.sum(tf.mul(dreamTensor, weights), -1, true);
    const srcLum = tf.sum(tf.mul(resizedSource, weights), -1, true);
    const srcRatios = tf.div(resizedSource, tf.add(srcLum, 1e-4));
    const colorTransferred = tf.mul(dreamLum, srcRatios);
    return tf.add(
      tf.mul(colorTransferred, blend),
      tf.mul(dreamTensor, 1 - blend),
    ).clipByValue(0, 1);
  });
}

function calcTvLoss(tf, image) {
  const [, h, w, c] = image.shape;
  const diffY = tf.sub(
    tf.slice(image, [0, 1, 0, 0], [1, h - 1, w, c]),
    tf.slice(image, [0, 0, 0, 0], [1, h - 1, w, c]),
  );
  const diffX = tf.sub(
    tf.slice(image, [0, 0, 1, 0], [1, h, w - 1, c]),
    tf.slice(image, [0, 0, 0, 0], [1, h, w - 1, c]),
  );
  return tf.add(tf.mean(tf.square(diffY)), tf.mean(tf.square(diffX)));
}

function upscaleWithDetail(tf, image, sourceTensor, targetH, targetW) {
  return tf.tidy(() => {
    const oldH = image.shape[1];
    const oldW = image.shape[2];
    const upscaled = tf.image.resizeBilinear(image, [targetH, targetW]);
    if (!sourceTensor || (oldH === targetH && oldW === targetW)) return upscaled;

    const srcTarget = tf.image.resizeBilinear(sourceTensor, [targetH, targetW]);
    const srcOldDown = tf.image.resizeBilinear(sourceTensor, [oldH, oldW]);
    const srcOldUp = tf.image.resizeBilinear(srcOldDown, [targetH, targetW]);
    const lostDetail = tf.sub(srcTarget, srcOldUp);

    return tf.add(upscaled, lostDetail).clipByValue(0, 1);
  });
}

function computeEdgeMask(tf, imageTensor, sensitivity = 0.5, mode = "edges") {
  return tf.tidy(() => {
    if (mode === "full" || !imageTensor) return null;

    const weights = tf.tensor1d([0.299, 0.587, 0.114]).reshape([1, 1, 1, 3]);
    const gray = tf.sum(tf.mul(imageTensor, weights), -1, true);

    const sobelX = tf.tensor4d(
      [-1, 0, 1, -2, 0, 2, -1, 0, 1],
      [3, 3, 1, 1],
    );
    const sobelY = tf.tensor4d(
      [-1, -2, -1, 0, 0, 0, 1, 2, 1],
      [3, 3, 1, 1],
    );

    const gx = tf.conv2d(gray, sobelX, 1, "same");
    const gy = tf.conv2d(gray, sobelY, 1, "same");
    const magnitude = tf.sqrt(tf.add(tf.square(gx), tf.square(gy)));

    const scaled = magnitude
      .mul(Number(sensitivity || 0.5) * 3.5)
      .clipByValue(0, 1);
    const dilated = tf.maxPool(scaled, [5, 5], 1, "same");
    const smoothed = tf.avgPool(dilated, [3, 3], 1, "same");

    if (mode === "inverse") {
      return tf.sub(1.0, smoothed);
    }
    return smoothed;
  });
}

function computeNeuralAttentionMask(
  tf,
  model,
  sourceTensor,
  sensitivity = 0.5,
  targetNode = null,
) {
  return tf.tidy(() => {
    if (!model || !sourceTensor) return null;
    const [, inH, inW] = sourceTensor.shape;
    const resizedInput = tf.image.resizeBilinear(sourceTensor, [299, 299]);
    let featMap = null;
    try {
      featMap = targetNode
        ? model.execute(resizedInput, targetNode)
        : model.execute(resizedInput);
    } catch (_) {
      return null;
    }
    const feat = Array.isArray(featMap) ? featMap[0] : featMap;
    if (!feat || feat.shape.length !== 4) return null;

    // Feature activation L2 norm across channel dimension: [1, H, W, 1]
    const energy = tf.norm(feat, 2, -1, true);

    // Compute mean and standard deviation to isolate semantic subjects from diffuse background noise
    const meanVal = energy.mean();
    const diff = energy.sub(meanVal);
    const stdVal = tf.sqrt(diff.square().mean());

    // Cutoff threshold: sensitivity scales from 0.1 (strict core) to 1.0 (broader subject outline)
    const sens = clamp(Number(sensitivity) || 0.5, 0.1, 1.0);
    const factor = 0.8 - sens * 0.6;
    const threshold = meanVal.add(stdVal.mul(factor));

    // ReLU gating: strictly zero out diffuse background activations
    const gated = tf.relu(energy.sub(threshold));
    const maxVal = gated.max();
    const normalized = tf.where(
      maxVal.greater(1e-6),
      gated.div(maxVal.add(1e-6)),
      tf.zerosLike(gated),
    );

    const scaled = tf.image.resizeBilinear(normalized, [inH, inW]);
    const dilated = tf.maxPool(scaled, [5, 5], 1, "same");
    return tf.avgPool(dilated, [5, 5], 1, "same").clipByValue(0, 1);
  });
}

function computeSpotlightMask(
  tf,
  targetH,
  targetW,
  xNorm = 0.5,
  yNorm = 0.5,
  radiusPixels = 120,
  hardness = 0.8,
  inverted = false,
) {
  return tf.tidy(() => {
    const cx = xNorm * targetW;
    const cy = yNorm * targetH;
    const rOuter = Math.max(10, radiusPixels);
    const h = clamp(Number(hardness) ?? 0.8, 0.0, 0.99);
    const featherRatio = Math.max(0.01, 1.0 - h);
    const rInner = Math.max(0, rOuter * (1 - featherRatio));

    const yGrid = tf.range(0, targetH).reshape([1, targetH, 1, 1]);
    const xGrid = tf.range(0, targetW).reshape([1, 1, targetW, 1]);
    const dy = yGrid.sub(cy);
    const dx = xGrid.sub(cx);
    const dist = tf.sqrt(tf.add(tf.square(dy), tf.square(dx)));

    const ramp = tf
      .sub(1.0, tf.div(tf.sub(dist, rInner), Math.max(1, rOuter - rInner)))
      .clipByValue(0, 1);

    return inverted ? tf.sub(1.0, ramp) : ramp;
  });
}

function applyFrequencyBandFilter(
  tf,
  updatedTensor,
  baseSourceTensor,
  mode = "full",
) {
  if (mode === "full" || !baseSourceTensor) return updatedTensor;

  return tf.tidy(() => {
    const [, h, w] = updatedTensor.shape;
    const resizedBase = tf.image.resizeBilinear(baseSourceTensor, [h, w]);

    if (mode === "high_freq_texture") {
      const baseLow = tf.avgPool(resizedBase, [5, 5], 1, "same");
      const updatedLow = tf.avgPool(updatedTensor, [5, 5], 1, "same");
      const updatedHigh = tf.sub(updatedTensor, updatedLow);
      return tf.add(baseLow, updatedHigh).clipByValue(0, 1);
    }

    if (mode === "micro_detail") {
      const baseLow = tf.avgPool(resizedBase, [9, 9], 1, "same");
      const upMid = tf.avgPool(updatedTensor, [3, 3], 1, "same");
      const upLow = tf.avgPool(updatedTensor, [9, 9], 1, "same");
      const microHigh = tf.sub(upMid, upLow);
      return tf.add(baseLow, microHigh).clipByValue(0, 1);
    }

    return updatedTensor;
  });
}

function getDepthLabel(depth) {
  switch (depth) {
    case "early_mixed5":
      return "MIXED_5 (EARLY)";
    case "deep_mixed7":
      return "MIXED_7 (DEEP)";
    case "multi_scale":
      return "MULTI-DEPTH";
    case "mid_mixed6":
    default:
      return "MIXED_6 (MID)";
  }
}

export class InceptionDreamModel {
  constructor() {
    this.model = null;
    this.modelPromise = null;
    this.loadError = null;
    this.state = "ADD AN IMAGE";
    this.mode = "original";
    this.sourceName = "";
    this.sourceLoaded = false;
    this.stepCount = 0;
    this.totalSteps = 0;
    this.isRunning = false;
    this.clockEnabled = false;
    this.sourceEpoch = 0;
    this.verifiedBackend = null;
    this.octaveTask = null;
    this.octaveCheckpoint = null;

    // Octave Engine State
    this.isOctaveRunning = false;
    this.isPaused = false;
    this.octaveAborted = false;
    this.octaveDone = false;
    this.progressStatus = "";
    this.lastDreamConfiguration = null;
    this.engineConfigurationEpoch = 0;
    this.resetEpoch = 0;
    this.resetPromise = null;
    this.isResetting = false;

    this.workingWidth = 448;
    this.workingHeight = 448;

    this.computeMax = 448;
    const makeCanvas = () =>
      typeof document !== "undefined" ? document.createElement("canvas") : null;
    this.sourceCanvas = makeCanvas();
    this.dreamCanvas = makeCanvas();
    this.previewCanvas = makeCanvas();
    [this.sourceCanvas, this.dreamCanvas, this.previewCanvas]
      .filter(Boolean)
      .forEach((c) => {
        c.width = this.workingWidth;
        c.height = this.workingHeight;
      });

    this.sourceTensor = null;
    this.dreamTensor = null;
    this.sourceImage = null;
    this.verifiedNodeMap = new Map();
    this.benchmarkMs = 0;
    this.presentationCanvas = null;
    this.parameters = null;
    this.customMaskCanvas = null;
    this.customMaskActive = false;
    this.spotlightState = {
      active: false,
      x: 0.5,
      y: 0.5,
      radius: 120,
      feather: 0.25,
      inverted: false,
    };
    this.detailFusion = 0.22;
  }

  get id() {
    return "inception-dream";
  }
  get name() {
    return "Inception Dream";
  }
  get family() {
    return "InceptionV3 feature visualization";
  }
  get backend() {
    const b = globalThis.tf?.getBackend?.();
    if (b === "webgpu") return "TENSORFLOW.JS / WEBGPU";
    if (b === "webgl") return "TENSORFLOW.JS / WEBGL";
    return this.model
      ? `TENSORFLOW.JS / ${String(b || "UNKNOWN").toUpperCase()}`
      : "GPU MODEL / ON DEMAND";
  }
  get description() {
    return "InceptionV3 feature visualization using multi-octave gradient ascent over the Mixed_6a and Mixed_6c activation tensors.";
  }
  get technicalInfo() {
    return {
      title: "Inception Dream",
      architecture: "InceptionV3 / TF-Slim GraphModel",
      trainingSet: "ImageNet-1K (1.2M natural images)",
      targetLayers: "Mixed_5 / Mixed_6 / Mixed_7 Concatenation Modules",
      objective:
        "Mean activation ascent / standard-deviation gradient normalization",
      octaveSchedule: "1.3× scale / three or five octave levels",
      browserInput: "1 × H × W × 3 FLOAT32",
      browserOutput: "MULTI-OCTAVE FEATURE VISUALIZATION",
      inferenceFramework: "TensorFlow.js",
      inferenceBackend: "WebGPU / WebGL with gradient verification",
      privacy: "Local image processing",
    };
  }
  get animated() {
    return true;
  }
  get usesInternalClock() {
    return true;
  }
  get available() {
    return true;
  }
  get pixelated() {
    return false;
  }
  get ready() {
    return Boolean(this.model);
  }
  isDynamic() {
    return false;
  }

  normalizeStoredParameter(key, value) {
    if (key === "pipelineMode") {
      if (value === "stream_morph") return PREVIEW_PIPELINE;
      if (value === "octave_still") return QUALITY_PIPELINE;
    }
    if (key === "resolutionProfile") {
      const valid = ["compact", "balanced", "high", "ultra"];
      return valid.includes(value) ? value : "balanced";
    }
    if (key === "targetDepth") {
      const valid = [
        "mid_mixed6",
        "early_mixed5",
        "deep_mixed7",
        "multi_scale",
      ];
      return valid.includes(value) ? value : "mid_mixed6";
    }
    if (key === "colorMode") {
      return value === "vivid" ? "vivid" : "natural";
    }
    if (key === "spatialFocus") {
      const valid = [
        "full",
        "edges",
        "inverse",
        "attention",
        "spotlight",
        "custom",
      ];
      return valid.includes(value) ? value : "full";
    }
    if (key === "edgeSensitivity") {
      const num = Number(value);
      return Number.isFinite(num) ? clamp(num, 0.1, 1.0) : 0.5;
    }
    if (key === "frequencyBand") {
      const valid = ["full", "high_freq_texture", "micro_detail"];
      return valid.includes(value) ? value : "high_freq_texture";
    }
    if (key === "brushRadius") {
      const num = Number(value);
      return Number.isFinite(num) ? clamp(num, 10, 150) : 40;
    }
    if (key === "wandTolerance") {
      const num = Number(value);
      return Number.isFinite(num) ? clamp(num, 10, 100) : 35;
    }
    if (key === "wandRadius") {
      const num = Number(value);
      return Number.isFinite(num) ? clamp(num, 30, 400) : 150;
    }
    if (key === "spotlightRadius") {
      const num = Number(value);
      return Number.isFinite(num) ? clamp(num, 30, 250) : 120;
    }
    if (key === "spotlightHardness") {
      const num = Number(value);
      return Number.isFinite(num) ? clamp(num, 0.0, 1.0) : 0.8;
    }
    if (key === "detailFusion") {
      const num = Number(value);
      return Number.isFinite(num) ? clamp(num, 0.0, 0.5) : 0.22;
    }
    return value;
  }

  get controls() {
    return [
      {
        key: "pipelineMode",
        label: "INFERENCE PIPELINE",
        type: "select",
        options: [
          {
            value: QUALITY_PIPELINE,
            label: "InceptionV3 Multi-Octave — Quality",
            compute: "balanced",
            guidance: "Recommended. Maximizes feature extraction across full multi-scale octave levels.",
          },
          {
            value: PREVIEW_PIPELINE,
            label: "InceptionV3 Multi-Octave — Reduced Compute",
            compute: "light",
            guidance: "Limits resolution to 320px and max 3 octaves for rapid iteration or lower-spec devices.",
          },
        ],
        default: QUALITY_PIPELINE,
        help: "Both profiles maximize target layer feature activations. Reduced Compute limits resolution, octave count, and ascent steps.",
      },
      {
        key: "resolutionProfile",
        label: "IMAGE RESOLUTION BASE",
        type: "select",
        options: [
          {
            value: "compact",
            label: "Compact (320px Base · ~540px Peak)",
            compute: "light",
            guidance: "Minimal memory footprint. Rapid step ascent with lightweight regional structures.",
          },
          {
            value: "balanced",
            label: "Balanced (448px Base · ~757px Peak)",
            compute: "balanced",
            guidance: "Recommended. Crisp micro-features and fluid gradient ascent on typical GPUs.",
          },
          {
            value: "high",
            label: "High Definition (576px Base · ~973px Peak)",
            compute: "high",
            guidance: "Detailed regional motifs. Ascent takes ~1.6× longer per step; smooth on modern GPUs.",
          },
          {
            value: "ultra",
            label: "Ultra HD (672px Base · ~1136px Peak)",
            compute: "intensive",
            guidance: "Maximum micro-structure fidelity. Demands higher VRAM and ascends noticeably slower.",
          },
        ],
        default: "balanced",
        help: "Base resolution for the multi-scale octave pyramid. Higher profiles synthesize exquisite micro-structural details at resolutions over 1100px. Requires more GPU VRAM.",
      },
      {
        key: "spatialFocus",
        label: "SPATIAL FOCUS TARGET",
        type: "select",
        options: [
          {
            value: "full",
            label: "Full Frame (Uniform Synthesis)",
            compute: "neutral",
            guidance: "Default. Ascends feature activations uniformly across all image pixels.",
          },
          {
            value: "edges",
            label: "Edge Contours & Silhouettes",
            compute: "neutral",
            guidance: "Recommended for structured art. Concentrates feature synthesis strictly along detected edges and object boundaries.",
          },
          {
            value: "inverse",
            label: "Inverse Background (Protect Subject)",
            compute: "neutral",
            guidance: "Protects high-contrast foreground subjects, synthesizing features exclusively into negative space.",
          },
          {
            value: "attention",
            label: "Neural Attention Saliency (Model Focus)",
            compute: "neutral",
            guidance: "Model-derived attention map concentrating synthesis on semantic subjects (faces, creatures, focal objects).",
          },
          {
            value: "spotlight",
            label: "Interactive Focus Spotlight",
            compute: "neutral",
            guidance: "Restricts synthesis strictly inside the interactive radial spotlight beam on the canvas.",
          },
          {
            value: "custom",
            label: "Custom Selection (Magic Wand / Mask)",
            compute: "neutral",
            guidance: "Uses the active Magic Wand or drawn selection mask.",
          },
        ],
        default: "full",
        help: "Restricts gradient ascent to specific spatial regions using GPU Sobel edge detection, Inception neural attention, or interactive spotlight/wand masks.",
      },
      {
        key: "edgeSensitivity",
        label: "CONTOUR SENSITIVITY",
        type: "range",
        min: 0.1,
        max: 1.0,
        step: 0.05,
        default: 0.5,
        help: "Controls edge detection and attention breadth. Low values capture only prominent outlines; high values include subtle textures.",
        getGuidance: (value) => {
          const s = Number(value) || 0.5;
          if (s < 0.3) {
            return {
              compute: "neutral",
              tag: "strict",
              text: "Restricts synthesis strictly to prominent high-contrast object outlines.",
            };
          }
          if (s <= 0.7) {
            return {
              compute: "neutral",
              tag: "recommended",
              text: "Recommended (0.5). Captures distinct object contours, silhouettes, and structural seams.",
            };
          }
          return {
            compute: "neutral",
            tag: "broad",
            text: "Broad contour detection. Includes faint textures and subtle surface edges.",
          };
        },
      },
      {
        key: "spotlightRadius",
        label: "SPOTLIGHT RADIUS",
        type: "range",
        min: 30,
        max: 250,
        step: 10,
        default: 120,
        help: "Beam radius in pixels for the interactive spotlight focus tool.",
        getGuidance: (value) => {
          const r = Number(value) || 120;
          if (r < 80) {
            return {
              compute: "neutral",
              tag: "tight",
              text: "Tight aperture for pinpoint motif synthesis.",
            };
          }
          if (r <= 160) {
            return {
              compute: "neutral",
              tag: "recommended",
              text: "Recommended (120px). Balanced regional focus beam.",
            };
          }
          return {
            compute: "neutral",
            tag: "wide",
            text: "Wide area illumination across major portions of the canvas.",
          };
        },
      },
      {
        key: "spotlightHardness",
        label: "SPOTLIGHT HARDNESS",
        type: "range",
        min: 0.0,
        max: 1.0,
        step: 0.05,
        default: 0.8,
        help: "Edge hardness / feathering for the interactive spotlight beam. 1.0 is sharp; lower values feather smoothly into surrounding areas.",
        getGuidance: (value) => {
          const h = Number(value) || 0.8;
          if (h < 0.4) {
            return {
              compute: "neutral",
              tag: "soft",
              text: "Soft feathering. Gentle, diffused transition into the background.",
            };
          }
          if (h <= 0.85) {
            return {
              compute: "neutral",
              tag: "recommended",
              text: "Recommended (0.8). Defined spotlight beam with pleasant edge anti-aliasing.",
            };
          }
          return {
            compute: "neutral",
            tag: "sharp",
            text: "Crisp boundary. Sharp cutoff with minimal edge blending.",
          };
        },
      },
      {
        key: "brushRadius",
        label: "BRUSH RADIUS",
        type: "range",
        min: 10,
        max: 150,
        step: 5,
        default: 40,
        help: "Stroke radius in pixels for the interactive mask brush tool.",
        getGuidance: (value) => {
          const r = Number(value) || 40;
          if (r < 25) {
            return {
              compute: "neutral",
              tag: "fine",
              text: "Fine tip for precise detail tracing and edge cleanup.",
            };
          }
          if (r <= 70) {
            return {
              compute: "neutral",
              tag: "recommended",
              text: "Recommended (40px). Balanced radius for blocking in and carving object masks.",
            };
          }
          return {
            compute: "neutral",
            tag: "broad",
            text: "Broad brush for covering large areas quickly.",
          };
        },
      },
      {
        key: "wandTolerance",
        label: "WAND COLOR TOLERANCE",
        type: "range",
        min: 10,
        max: 100,
        step: 5,
        default: 35,
        help: "Color distance threshold for Magic Wand object flood selection.",
        getGuidance: (value) => {
          const t = Number(value) || 35;
          if (t < 25) {
            return {
              compute: "neutral",
              tag: "strict",
              text: "Strict color matching. Selects only very uniform color regions.",
            };
          }
          if (t <= 55) {
            return {
              compute: "neutral",
              tag: "recommended",
              text: "Recommended (35). Captures complete foreground objects cleanly.",
            };
          }
          return {
            compute: "neutral",
            tag: "broad",
            text: "Broad tolerance. Floods across varied lighting and textured regions.",
          };
        },
      },
      {
        key: "wandRadius",
        label: "WAND REACH RADIUS",
        type: "range",
        min: 30,
        max: 400,
        step: 10,
        default: 150,
        help: "Maximum reach distance in pixels for the Magic Wand. Prevents the selection from escaping beyond the local object.",
        getGuidance: (value) => {
          const r = Number(value) || 150;
          if (r < 100) {
            return {
              compute: "neutral",
              tag: "tight",
              text: "Tight local reach. Confines selection strictly to small details.",
            };
          }
          if (r <= 220) {
            return {
              compute: "neutral",
              tag: "recommended",
              text: "Recommended (150px). Balanced object reach with leak containment.",
            };
          }
          return {
            compute: "neutral",
            tag: "wide",
            text: "Wide reach aperture. Selects across larger objects and areas.",
          };
        },
      },
      {
        key: "targetDepth",
        label: "FEATURE LAYER DEPTH",
        type: "select",
        options: [
          {
            value: "mid_mixed6",
            label: "Intermediate Motifs (Mixed_6)",
            compute: "balanced",
            guidance: "Recommended. Balanced mid-level features, circular contours, and ornate regional motifs.",
          },
          {
            value: "early_mixed5",
            label: "Early Textures & Lattices (Mixed_5)",
            compute: "light",
            guidance: "Shallow gradient backpropagation. Synthesizes fine geometric lattices and edge textures.",
          },
          {
            value: "deep_mixed7",
            label: "Deep Semantic Forms (Mixed_7)",
            compute: "moderate",
            guidance: "Full network backpropagation. Extracts macro-structural forms and high-level contours.",
          },
          {
            value: "multi_scale",
            label: "Multi-Depth Composite (Mixed_5+6+7)",
            compute: "high",
            guidance: "Computes 3 parallel layer gradients simultaneously. Rich hybrid textures with ~1.5× compute overhead.",
          },
        ],
        default: "mid_mixed6",
        help: "InceptionV3 layer depth: Early Mixed_5 synthesizes high-frequency geometric lattices; Mid Mixed_6 activates intermediate regional motifs and circular contours; Deep Mixed_7 extracts macro-structural object representations.",
      },
      {
        key: "octaveCount",
        label: "OCTAVE LEVELS",
        type: "select",
        options: [
          {
            value: "3",
            label: "3 Levels",
            compute: "light",
            guidance: "Fast 3-tier pyramid (0.77× to 1.3×). Good for rapid styling before higher-octave refinement.",
          },
          {
            value: "5",
            label: "5 Levels",
            compute: "balanced",
            guidance: "Recommended. Full 5-tier pyramid (0.59× to 1.69×) synthesizing multi-scale structures.",
          },
        ],
        default: "5",
      },
      {
        key: "stepsPerOctave",
        label: "ASCENT STEPS PER OCTAVE",
        type: "range",
        min: 10,
        max: 50,
        step: 5,
        default: 50,
        getGuidance: (value) => {
          const steps = Number(value) || 50;
          if (steps <= 25) {
            return {
              compute: "light",
              text: `Quick pass (~${steps * 5} total steps). Subtle feature imprint, rapid completion.`,
            };
          }
          if (steps <= 40) {
            return {
              compute: "balanced",
              text: `Recommended (~${steps * 5} total steps). Well-defined motifs, steady ascent.`,
            };
          }
          return {
            compute: "high",
            text: `Deep saturation (~${steps * 5} total steps). Prominent feature formation, longest processing time.`,
          };
        },
      },
      {
        key: "dreamStrength",
        label: "ASCENT STEP SCALE",
        type: "range",
        min: 0.2,
        max: 2.0,
        step: 0.05,
        default: 1.0,
        getGuidance: (value) => {
          const scale = Number(value) || 1.0;
          if (scale < 0.8) {
            return {
              compute: "neutral",
              tag: "gentle",
              text: "Delicate, low-contrast feature impressions.",
            };
          }
          if (scale <= 1.3) {
            return {
              compute: "neutral",
              tag: "recommended",
              text: "Recommended (1.0). Clean feature emergence without gradient distortion.",
            };
          }
          return {
            compute: "neutral",
            tag: "aggressive",
            text: "Fast feature emergence; high values may introduce high-contrast gradient clipping.",
          };
        },
      },
      {
        key: "spatialJitter",
        label: "SPATIAL JITTER (PIXELS)",
        type: "range",
        min: 0,
        max: 32,
        step: 4,
        default: 16,
        help: "Random circular roll per step. Mitigates convolutional grid-boundary seams and creates seamless, fluid contours.",
        getGuidance: (value) => {
          const jitter = Number(value) || 0;
          if (jitter === 0) {
            return {
              compute: "neutral",
              tag: "disabled",
              text: "Jitter disabled. Convolutional grid boundary seams may appear.",
            };
          }
          if (jitter <= 20) {
            return {
              compute: "neutral",
              tag: "recommended",
              text: "Recommended (16px). Eliminates tile seams with negligible compute overhead.",
            };
          }
          return {
            compute: "neutral",
            tag: "fluid",
            text: "Wide circular roll. Maximum seam elimination for fluid, organic boundaries.",
          };
        },
      },
      {
        key: "smoothness",
        label: "DETAIL SMOOTHNESS",
        type: "range",
        min: 0.0,
        max: 0.5,
        step: 0.05,
        default: 0.15,
        help: "Total Variation regularizer weight. Suppresses high-frequency pixel noise and grain for smooth, defined structures.",
        getGuidance: (value) => {
          const s = Number(value) || 0;
          if (s < 0.05) {
            return {
              compute: "neutral",
              tag: "unregularized",
              text: "Raw pixel gradients; susceptible to high-frequency speckling noise.",
            };
          }
          if (s <= 0.25) {
            return {
              compute: "neutral",
              tag: "recommended",
              text: "Recommended (0.15). TV regularizer suppresses noise while keeping contours sharp.",
            };
          }
          return {
            compute: "neutral",
            tag: "smooth",
            text: "Strong regularization. Suppresses fine grain, yielding softer, smoother textures.",
          };
        },
      },
      {
        key: "colorMode",
        label: "COLOR PALETTE",
        type: "select",
        options: [
          {
            value: "natural",
            label: "Natural Palette (Preserve Source Colors)",
            compute: "neutral",
            guidance: "Recommended. Locks chrominance to source photo, preventing unnatural color runaway.",
          },
          {
            value: "vivid",
            label: "Full Contrast (Unconstrained Gradients)",
            compute: "neutral",
            guidance: "Allows unconstrained multi-channel gradient ascent for high-saturation color drift.",
          },
        ],
        default: "natural",
        help: "Natural Palette transfers source image chrominance to preserve natural tones; Full Contrast permits raw multi-channel gradient saturation.",
      },
      {
        key: "frequencyBand",
        label: "TEXTURE FREQUENCY BAND",
        type: "select",
        options: [
          {
            value: "high_freq_texture",
            label: "High-Frequency Texture Band (Preserve Base Lighting)",
            compute: "balanced",
            guidance: "Recommended. Locks ambient lighting, shadows, and natural tones to source photo while developing sharp micro-textures.",
          },
          {
            value: "full",
            label: "Full Spectrum (Standard Ascent)",
            compute: "neutral",
            guidance: "Standard multi-frequency gradient ascent across all image layers.",
          },
          {
            value: "micro_detail",
            label: "Micro-Detail Band (Ultra-Fine Textures)",
            compute: "light",
            guidance: "Double-Laplacian bandpass isolating ultra-fine geometric micro-textures.",
          },
        ],
        default: "high_freq_texture",
        help: "High-Frequency Texture Band prevents blotchy color/lighting wash-out by locking large-scale photographic illumination and focusing gradient ascent on intricate micro-textures.",
      },
      {
        key: "detailFusion",
        label: "PHOTO DETAIL FUSION",
        type: "range",
        min: 0.0,
        max: 0.5,
        step: 0.05,
        default: 0.22,
        help: "Fuses high-frequency photographic sensor details and micro-contrast onto the live canvas and exports for ultra-sharp hallucinations.",
        getGuidance: (value) => {
          const f = Number(value) || 0;
          if (f < 0.05) {
            return {
              compute: "neutral",
              tag: "raw",
              text: "Pure neural dream ascent; no photographic detail overlay.",
            };
          }
          if (f <= 0.3) {
            return {
              compute: "neutral",
              tag: "recommended",
              text: "Recommended (0.22). Crisp camera-sharp micro-contrast with full dream saturation.",
            };
          }
          return {
            compute: "neutral",
            tag: "crisp",
            text: "Strong photographic edge lock. Maximizes camera texture fidelity.",
          };
        },
      },
    ];
  }

  setDimensions(width, height, maxDim = 448) {
    const targetMax = Number(maxDim) || 448;
    const sourceWidth = Number(this.sourceImage?.width) || Number(width) || 1;
    const sourceHeight =
      Number(this.sourceImage?.height) || Number(height) || 1;
    const aspect = sourceWidth / sourceHeight;
    let w, h;
    if (aspect >= 1.0) {
      w = targetMax;
      h = Math.round(targetMax / aspect);
    } else {
      h = targetMax;
      w = Math.round(targetMax * aspect);
    }
    w = Math.max(128, Math.min(targetMax, Math.floor(w / 8) * 8));
    h = Math.max(128, Math.min(targetMax, Math.floor(h / 8) * 8));

    if (this.workingWidth === w && this.workingHeight === h) return;

    const previousDream = document.createElement("canvas");
    previousDream.width = this.dreamCanvas.width;
    previousDream.height = this.dreamCanvas.height;
    if (previousDream.width && previousDream.height) {
      previousDream
        .getContext("2d", { alpha: false })
        .drawImage(this.dreamCanvas, 0, 0);
    }

    this.workingWidth = w;
    this.workingHeight = h;
    [this.sourceCanvas, this.dreamCanvas, this.previewCanvas].forEach((c) => {
      c.width = w;
      c.height = h;
    });
    if (previousDream.width && previousDream.height) {
      this.dreamCanvas
        .getContext("2d", { alpha: false })
        .drawImage(previousDream, 0, 0, w, h);
    }

    if (this.sourceImage) {
      const ctx = this.sourceCanvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      drawContain(ctx, this.sourceImage, w, h);
    }
    if (this.sourceLoaded) void this.resetDream("setDimensions");
  }

  async setSourceFile(file) {
    if (!file?.type?.startsWith("image/") || file.size > 24 * 1024 * 1024)
      throw new Error("Choose an image smaller than 24 MB.");
    const sourceEpoch = ++this.sourceEpoch;
    const decoded = await (typeof createImageBitmap === "function"
      ? createImageBitmap(file)
      : new Promise((res, rej) => {
          const img = new Image();
          const url = URL.createObjectURL(file);
          img.onload = () => {
            URL.revokeObjectURL(url);
            res(img);
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            rej(new Error("Could not decode the image."));
          };
          img.src = url;
        }));

    try {
      if (sourceEpoch !== this.sourceEpoch) return false;
      if (decoded.width * decoded.height > 32 * 1024 * 1024)
        throw new Error("The image exceeds the 32-megapixel working limit.");
      this.stop();
      await this.waitForIdle();
      if (sourceEpoch !== this.sourceEpoch) return false;
      this.sourceLoaded = false;
      if (!this.sourceImage)
        this.sourceImage = document.createElement("canvas");
      this.sourceImage.width = decoded.naturalWidth || decoded.width;
      this.sourceImage.height = decoded.naturalHeight || decoded.height;
      const ctx = this.sourceImage.getContext("2d", { alpha: false });
      ctx.drawImage(decoded, 0, 0);
      this.setDimensions(
        this.sourceImage.width,
        this.sourceImage.height,
        this.computeMax,
      );

      const small = this.sourceCanvas.getContext("2d", { alpha: false });
      small.fillStyle = "#000";
      small.fillRect(0, 0, this.workingWidth, this.workingHeight);
      drawContain(small, decoded, this.workingWidth, this.workingHeight);
    } finally {
      decoded.close?.();
    }

    this.sourceName = String(file.name || "LOCAL IMAGE").slice(0, 80);
    this.sourceLoaded = true;
    this.octaveDone = false;
    this.customMaskCanvas = null;
    this.customMaskActive = false;
    if (this.spotlightState) {
      this.spotlightState.active = false;
      this.spotlightState.inverted = false;
    }
    this.mode = "original";
    await this.resetDream("newSource");
    this.onStateChange?.();
  }

  setCustomMaskCanvas(canvas) {
    this.customMaskCanvas = canvas;
    this.customMaskActive = true;
    if (this.spotlightState) this.spotlightState.active = false;
    if (this.parameters) this.parameters.spatialFocus = "custom";
    this.onStateChange?.();
  }

  clearCustomMask() {
    this.customMaskCanvas = null;
    this.customMaskActive = false;
    if (this.spotlightState) {
      this.spotlightState.active = false;
      this.spotlightState.inverted = false;
    }
    if (this.parameters) this.parameters.spatialFocus = "full";
    this.onStateChange?.();
  }

  invertCustomMask() {
    if (this.customMaskCanvas && this.customMaskActive) {
      const ctx = this.customMaskCanvas.getContext("2d");
      const imgData = ctx.getImageData(
        0,
        0,
        this.customMaskCanvas.width,
        this.customMaskCanvas.height,
      );
      for (let i = 0; i < imgData.data.length; i += 4) {
        const inv = 255 - imgData.data[i];
        imgData.data[i] = inv;
        imgData.data[i + 1] = inv;
        imgData.data[i + 2] = inv;
        imgData.data[i + 3] = inv;
      }
      ctx.putImageData(imgData, 0, 0);
    } else if (this.spotlightState?.active) {
      this.spotlightState.inverted = !this.spotlightState.inverted;
    }
    this.onStateChange?.();
  }

  setSpotlight(xNorm, yNorm, radiusPixels = 120, hardness = 0.8) {
    this.spotlightState = {
      active: true,
      x: clamp(Number(xNorm) || 0.5, 0, 1),
      y: clamp(Number(yNorm) || 0.5, 0, 1),
      radius: clamp(Number(radiusPixels) || 120, 30, 250),
      hardness: clamp(Number(hardness) || 0.8, 0.0, 1.0),
      feather: 1.0 - clamp(Number(hardness) || 0.8, 0.0, 1.0),
      inverted: Boolean(this.spotlightState?.inverted),
    };
    this.customMaskActive = false;
    if (this.parameters) {
      this.parameters.spatialFocus = "spotlight";
      this.parameters.spotlightRadius = this.spotlightState.radius;
      this.parameters.spotlightHardness = this.spotlightState.hardness;
    }
    this.onStateChange?.();
  }

  async extractAndApplyEdgeMask() {
    if (!this.sourceTensor) return;
    const tf = globalThis.tf;
    if (!tf) return;
    const sensitivity = clamp(
      Number(this.parameters?.edgeSensitivity ?? 0.5),
      0.1,
      1.0,
    );
    const maskTensor = tf.tidy(() =>
      computeEdgeMask(tf, this.sourceTensor, sensitivity, "edges"),
    );
    if (!maskTensor) return;

    const canvas = document.createElement("canvas");
    canvas.width = this.workingWidth;
    canvas.height = this.workingHeight;
    const frame = maskTensor.squeeze([0]);
    try {
      const data = await frame.data();
      const ctx = canvas.getContext("2d");
      const imgData = ctx.createImageData(
        this.workingWidth,
        this.workingHeight,
      );
      for (let i = 0; i < data.length; i += 1) {
        const v = Math.round(data[i] * 255);
        const idx = i * 4;
        imgData.data[idx] = v;
        imgData.data[idx + 1] = v;
        imgData.data[idx + 2] = v;
        imgData.data[idx + 3] = v;
      }
      ctx.putImageData(imgData, 0, 0);
      this.setCustomMaskCanvas(canvas);
      if (this.parameters) this.parameters.spatialFocus = "edges";
    } finally {
      frame.dispose();
      maskTensor.dispose();
    }
  }

  async extractAndApplyNeuralAttentionMask() {
    if (!this.sourceTensor || !this.model) return;
    const tf = globalThis.tf;
    if (!tf) return;
    const sensitivity = clamp(
      Number(this.parameters?.edgeSensitivity ?? 0.5),
      0.1,
      1.0,
    );
    const node =
      this.verifiedNodeMap.get("mixed_6a") ||
      this.verifiedNodeMap.get("mixed_5c");
    const maskTensor = tf.tidy(() =>
      computeNeuralAttentionMask(
        tf,
        this.model,
        this.sourceTensor,
        sensitivity,
        node,
      ),
    );
    if (!maskTensor) return;

    const canvas = document.createElement("canvas");
    canvas.width = this.workingWidth;
    canvas.height = this.workingHeight;
    const frame = maskTensor.squeeze([0]);
    try {
      const data = await frame.data();
      const ctx = canvas.getContext("2d");
      const imgData = ctx.createImageData(
        this.workingWidth,
        this.workingHeight,
      );
      for (let i = 0; i < data.length; i += 1) {
        const v = Math.round(data[i] * 255);
        const idx = i * 4;
        imgData.data[idx] = v;
        imgData.data[idx + 1] = v;
        imgData.data[idx + 2] = v;
        imgData.data[idx + 3] = v;
      }
      ctx.putImageData(imgData, 0, 0);
      this.setCustomMaskCanvas(canvas);
      if (this.parameters) this.parameters.spatialFocus = "attention";
    } finally {
      frame.dispose();
      maskTensor.dispose();
    }
  }

  computeActiveMask(tf, octaveH, octaveW, baseSource) {
    if (!baseSource) return null;
    return tf.tidy(() => {
      const spatialFocus = this.parameters?.spatialFocus || "full";
      const edgeSensitivity = clamp(
        Number(this.parameters?.edgeSensitivity ?? 0.5),
        0.1,
        1.0,
      );

      // 1. Custom Mask (Magic Wand selection or manually extracted mask)
      if (this.customMaskActive && this.customMaskCanvas) {
        const rawMask = tf.browser.fromPixels(this.customMaskCanvas, 1);
        const floatMask = rawMask.toFloat().div(255).expandDims(0);
        return tf.image.resizeBilinear(floatMask, [octaveH, octaveW]);
      }

      // 2. Interactive Spotlight Mode
      if (this.spotlightState?.active || spatialFocus === "spotlight") {
        const sp = this.spotlightState || {
          x: 0.5,
          y: 0.5,
          radius: 120,
          hardness: 0.8,
        };
        const radius = Number(
          this.parameters?.spotlightRadius || sp.radius || 120,
        );
        const hardness = Number(
          this.parameters?.spotlightHardness ?? sp.hardness ?? 0.8,
        );
        return computeSpotlightMask(
          tf,
          octaveH,
          octaveW,
          sp.x,
          sp.y,
          radius,
          hardness,
          Boolean(sp.inverted),
        );
      }

      // 3. Neural Attention Saliency
      if (spatialFocus === "attention") {
        const node =
          this.verifiedNodeMap.get("mixed_6a") ||
          this.verifiedNodeMap.get("mixed_5c");
        const srcOctave = tf.image.resizeBilinear(baseSource, [
          octaveH,
          octaveW,
        ]);
        return computeNeuralAttentionMask(
          tf,
          this.model,
          srcOctave,
          edgeSensitivity,
          node,
        );
      }

      // 4. Classical Edge & Contour Detection
      if (spatialFocus === "edges" || spatialFocus === "inverse") {
        const srcOctave = tf.image.resizeBilinear(baseSource, [
          octaveH,
          octaveW,
        ]);
        return computeEdgeMask(
          tf,
          srcOctave,
          edgeSensitivity,
          spatialFocus,
        );
      }

      // 5. Full Frame (no mask)
      return null;
    });
  }

  async requireGpu(preferred = ["webgpu", "webgl"]) {
    return activateTensorFlowBackend(preferred);
  }

  async verifyAndMapNodes(model) {
    this.verifiedNodeMap.clear();
    const tf = globalThis.tf;
    if (!model) return;

    const layerKeys = [
      "mixed_5b",
      "mixed_5c",
      "mixed_5d",
      "mixed_6a",
      "mixed_6b",
      "mixed_6c",
      "mixed_6d",
      "mixed_6e",
      "mixed_7a",
      "mixed_7b",
      "mixed_7c",
    ];
    const allValidNodes = [];

    const isGraphModel = Boolean(model.executor?.graph?.nodes);
    console.info(
      `[Inception Dream] Model format detected: ${isGraphModel ? "GraphModel (SavedModel)" : "LayersModel (Keras)"}`,
    );

    if (!isGraphModel || typeof model.execute !== "function") {
      throw new Error(
        "Inception Dream requires a TensorFlow.js GraphModel with executable intermediate nodes.",
      );
    }

    for (const [name, node] of Object.entries(model.executor.graph.nodes)) {
      const op = String(node.op || "").toLowerCase();
      const lower = name.toLowerCase();

      if (op === "const" || op === "placeholder") continue;
      if (
        lower.endsWith("/axis") ||
        lower.endsWith("/shape") ||
        lower.endsWith("/read")
      )
        continue;
      if (lower.includes("weights") || lower.includes("biases")) continue;

      allValidNodes.push({ name, op });
    }

    const searchPatterns = {
      mixed_5b: ["mixed_5b", "mixed5b"],
      mixed_5c: ["mixed_5c", "mixed5c"],
      mixed_5d: ["mixed_5d", "mixed5d"],
      mixed_6a: ["mixed_6a", "mixed6a"],
      mixed_6b: ["mixed_6b", "mixed6b"],
      mixed_6c: ["mixed_6c", "mixed6c"],
      mixed_6d: ["mixed_6d", "mixed6d"],
      mixed_6e: ["mixed_6e", "mixed6e"],
      mixed_7a: ["mixed_7a", "mixed7a"],
      mixed_7b: ["mixed_7b", "mixed7b"],
      mixed_7c: ["mixed_7c", "mixed7c"],
    };

    const probe = tf.zeros([1, 192, 192, 3]);

    for (const key of layerKeys) {
      const patterns = searchPatterns[key] || [key];
      const candidates = [];

      for (const node of allValidNodes) {
        const nLower = node.name.toLowerCase();
        if (
          patterns.some((p) => nLower.includes(p)) &&
          (node.op.includes("concat") || nLower.endsWith("concat"))
        ) {
          candidates.push(node.name);
        }
      }

      for (const candidate of candidates) {
        let isDifferentiable = false;
        try {
          isDifferentiable = tf.tidy(() => {
            const probeLoss = (x) => {
              const out = model.execute(x, candidate);
              const t = Array.isArray(out) ? out[0] : out;
              return t.mean();
            };
            const { grad } = tf.valueAndGrad(probeLoss)(probe);
            if (!grad || grad.shape.length !== 4) return false;
            const meanAbs = grad.abs().mean().dataSync()[0];
            return Number.isFinite(meanAbs) && meanAbs > 1e-12;
          });
        } catch (_) {
          isDifferentiable = false;
        }

        if (isDifferentiable) {
          this.verifiedNodeMap.set(key, candidate);
          console.info(
            `[Inception Dream] Verified differentiable layer: ${key} -> "${candidate}"`,
          );
          break;
        }
      }
    }

    probe.dispose();
    console.info(
      `[Inception Dream] Verified ${this.verifiedNodeMap.size}/${layerKeys.length} dream target layers.`,
    );
    if (!this.verifiedNodeMap.has("mixed_6a") && !this.verifiedNodeMap.has("mixed_6c")) {
      throw new Error(
        "The backend could not differentiate InceptionV3 concatenation outputs.",
      );
    }
  }

  resolveTargetNodes(parameters = this.parameters) {
    const depth = parameters?.targetDepth || "mid_mixed6";
    let preferred;
    switch (depth) {
      case "early_mixed5":
        preferred = ["mixed_5b", "mixed_5c", "mixed_5d"];
        break;
      case "deep_mixed7":
        preferred = ["mixed_7a", "mixed_7b", "mixed_7c"];
        break;
      case "multi_scale":
        preferred = ["mixed_5c", "mixed_6c", "mixed_7b"];
        break;
      case "mid_mixed6":
      default:
        preferred = ["mixed_6a", "mixed_6c"];
        break;
    }
    const resolved = preferred
      .map((key) => this.verifiedNodeMap.get(key))
      .filter(Boolean);
    if (resolved.length) return resolved;
    return [
      this.verifiedNodeMap.get("mixed_6a"),
      this.verifiedNodeMap.get("mixed_6c"),
    ].filter(Boolean);
  }

  activationLoss(activation) {
    return activation.mean();
  }

  normalizeGradient(gradient) {
    const tf = globalThis.tf;
    return gradient.div(tf.moments(gradient).variance.sqrt().add(1e-8));
  }

  async ensureModel(onStatus) {
    if (this.ready) return this.model;
    if (!this.modelPromise) {
      this.modelPromise = (async () => {
        this.loadError = null;
        const started = performance.now();
        const tf = await ensureTensorFlow();
        let failure;
        for (const backend of ["webgpu", "webgl"]) {
          if (!tf.findBackendFactory(backend)) continue;
          let candidate = null;
          try {
            onStatus?.(`CHECKING ${backend.toUpperCase()} GRADIENTS`);
            await this.requireGpu([backend]);
            // Consume shards sequentially instead of waiting for all response
            // headers before reading bodies (which can exhaust HTTP/1 connections).
            candidate = await tf.loadGraphModel(MODEL_URL, {
              streamWeights: true,
            });
            await this.verifyAndMapNodes(candidate);
            this.model = candidate;
            this.verifiedBackend = backend;
            this.benchmarkMs = performance.now() - started;
            this.state = "INCEPTIONV3 READY";
            if (this.sourceLoaded) await this.resetDream();
            this.onStateChange?.();
            return this.model;
          } catch (error) {
            candidate?.dispose();
            this.model = null;
            failure = error;
          }
        }
        throw (
          failure ||
          new Error("InceptionV3 requires a supported WebGPU or WebGL backend.")
        );
      })()
        .catch((error) => {
          this.loadError = error.message;
          this.state = "MODEL LOAD FAILED";
          throw error;
        })
        .finally(() => {
          this.modelPromise = null;
        });
    }
    return this.modelPromise;
  }

  async waitForIdle() {
    await Promise.all(
      [this.octaveTask, this.resetPromise]
        .filter(Boolean)
        .map((task) => task.catch(() => undefined)),
    );
  }

  resetDream(caller = "unknown") {
    this.clearCheckpoint();
    const requestEpoch = ++this.resetEpoch;
    this.isResetting = true;
    const previousReset = this.resetPromise || Promise.resolve();
    const task = previousReset
      .catch(() => undefined)
      .then(() =>
        this.performReset(requestEpoch, {
          preservePreview: caller === "setDimensions",
          reason: caller,
        }),
      );
    this.resetPromise = task;
    return task.finally(() => {
      if (this.resetPromise === task) this.resetPromise = null;
    });
  }

  async performReset(
    requestEpoch,
    { preservePreview = false, reason = "unknown" } = {},
  ) {
    if (requestEpoch !== this.resetEpoch) return false;
    this.isResetting = true;
    this.haltEngine();

    const isExplicitReset =
      reason === "userReset" ||
      reason === "newSource" ||
      !this.dreamTensor;

    let nextSourceTensor = null;
    let nextDreamTensor = null;
    let completed = false;
    try {
      while (this.isOctaveRunning) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (requestEpoch !== this.resetEpoch) return false;
      }

      this.octaveAborted = false;
      this.octaveDone = false;
      this.isPaused = false;
      if (isExplicitReset) {
        this.progressStatus = "";
        this.stepCount = 0;
        this.totalSteps = 0;
      }

      if (!this.sourceLoaded) {
        this.sourceTensor?.dispose();
        this.dreamTensor?.dispose();
        this.sourceTensor = null;
        this.dreamTensor = null;
        this.totalSteps = 0;
        completed = true;
        return true;
      }

      const tf = await ensureTensorFlow();
      if (requestEpoch !== this.resetEpoch) return false;

      nextSourceTensor = tf.tidy(() =>
        tf.browser
          .fromPixels(this.sourceCanvas)
          .toFloat()
          .div(255)
          .expandDims(0),
      );

      if (isExplicitReset) {
        nextDreamTensor = nextSourceTensor.clone();
      } else {
        // Dimensions or parameter change: preserve existing dream from dreamCanvas!
        nextDreamTensor = tf.tidy(() =>
          tf.browser
            .fromPixels(this.dreamCanvas)
            .toFloat()
            .div(255)
            .expandDims(0),
        );
      }

      const stagingCanvas = document.createElement("canvas");
      stagingCanvas.width = this.workingWidth;
      stagingCanvas.height = this.workingHeight;
      const frame = nextDreamTensor.squeeze([0]);
      try {
        await tf.browser.toPixels(frame, stagingCanvas);
      } finally {
        frame.dispose();
      }
      if (requestEpoch !== this.resetEpoch) return false;

      this.sourceTensor?.dispose();
      this.dreamTensor?.dispose();
      this.sourceTensor = nextSourceTensor;
      this.dreamTensor = nextDreamTensor;
      nextSourceTensor = null;
      nextDreamTensor = null;
      if (!preservePreview && isExplicitReset)
        this.dreamCanvas
          .getContext("2d", { alpha: false })
          .drawImage(stagingCanvas, 0, 0);
      this.state =
        this.totalSteps > 0
          ? `SYNTHESIS READY · ${this.totalSteps} STEPS`
          : "SYNTHESIS READY";
      completed = true;
      return true;
    } finally {
      nextSourceTensor?.dispose();
      nextDreamTensor?.dispose();
      if (requestEpoch === this.resetEpoch) {
        this.isResetting = false;
        if (
          completed &&
          this.mode !== "original" &&
          this.clockEnabled &&
          this.ready &&
          this.sourceLoaded &&
          !this.isPaused &&
          reason !== "setDimensions"
        ) {
          this.start();
        }
      }
    }
  }

  setMode(mode) {
    if (!["original", "dream"].includes(mode)) return;
    this.mode = mode;
    if (mode === "original") {
      if (this.isOctaveRunning) this.isPaused = true;
      this.stop();
    } else {
      this.isPaused = false;
      this.requestStart();
    }
  }

  pause() {
    if (!this.isRunning && !this.isOctaveRunning) return false;
    this.isPaused = true;
    this.progressStatus = "SYNTHESIS PAUSED";
    this.stop();
    this.onStateChange?.();
    return true;
  }

  resume() {
    if (!this.isPaused && !this.octaveCheckpoint) return false;
    this.isPaused = false;
    this.mode = "dream";
    this.progressStatus = "RESUMING SYNTHESIS";
    this.requestStart();
    this.onStateChange?.();
    return true;
  }

  haltEngine({ detachPresentation = false } = {}) {
    this.engineConfigurationEpoch += 1;
    this.isRunning = false;
    this.octaveAborted = true;
    if (detachPresentation) this.presentationCanvas = null;
  }

  stop() {
    this.haltEngine();
  }

  clearCheckpoint() {
    this.octaveCheckpoint?.image.dispose();
    this.octaveCheckpoint = null;
  }

  cancel() {
    this.clearCheckpoint();
    this.sourceEpoch += 1;
    this.clockEnabled = false;
    this.resetEpoch += 1;
    this.isResetting = false;
    this.haltEngine({ detachPresentation: true });
  }

  pipelineMode(parameters = this.parameters) {
    return parameters?.pipelineMode === PREVIEW_PIPELINE
      ? PREVIEW_PIPELINE
      : QUALITY_PIPELINE;
  }

  synchronizeDreamConfiguration(parameters) {
    const signature = [
      this.pipelineMode(parameters),
      parameters?.resolutionProfile,
      parameters?.targetDepth,
      parameters?.octaveCount,
      parameters?.stepsPerOctave,
      parameters?.dreamStrength,
      parameters?.spatialJitter,
      parameters?.smoothness,
      parameters?.colorMode,
      parameters?.spatialFocus,
      parameters?.edgeSensitivity,
      parameters?.frequencyBand,
      parameters?.wandTolerance,
      parameters?.spotlightRadius,
    ].join(":");
    if (this.lastDreamConfiguration === signature) return;

    const hadConfiguration = this.lastDreamConfiguration !== null;
    this.lastDreamConfiguration = signature;
    if (!hadConfiguration) return;

    if (this.isRunning && this.mode !== "original") {
      this.clearCheckpoint();
      this.octaveDone = false;
      this.isPaused = false;
      this.haltEngine();
      const epoch = this.engineConfigurationEpoch;

      void (async () => {
        while (this.isOctaveRunning) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (epoch !== this.engineConfigurationEpoch) return;
        }
        if (
          epoch === this.engineConfigurationEpoch &&
          this.clockEnabled &&
          this.ready &&
          this.sourceLoaded &&
          this.mode !== "original" &&
          !this.isPaused
        ) {
          this.start();
        }
      })();
    } else {
      // Idle, paused, or completed: preserve existing canvas and cumulative step count
      const depthLabel = getDepthLabel(parameters?.targetDepth);
      if (this.totalSteps > 0) {
        this.progressStatus = `TOTAL STEPS: ${this.totalSteps} · ACTIVE: ${depthLabel}`;
      }
      this.onStateChange?.();
    }
  }

  requestStart() {
    if (this.isRunning || this.isResetting || this.isPaused) return false;
    if (!this.isOctaveRunning) return this.start();
    const epoch = this.engineConfigurationEpoch;
    void (async () => {
      while (this.isOctaveRunning) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (epoch !== this.engineConfigurationEpoch) return;
      }
      if (
        epoch === this.engineConfigurationEpoch &&
        this.clockEnabled &&
        this.ready &&
        this.sourceLoaded &&
        this.mode !== "original" &&
        !this.isPaused
      ) {
        this.start();
      }
    })();
    return false;
  }

  start() {
    if (
      this.isRunning ||
      this.isOctaveRunning ||
      !this.clockEnabled ||
      this.isResetting ||
      !this.ready ||
      this.mode === "original" ||
      !this.sourceLoaded ||
      this.isPaused
    )
      return false;

    if (this.octaveDone) return false;

    this.isRunning = true;
    this.octaveAborted = false;
    const epoch = ++this.engineConfigurationEpoch;
    this.octaveTask = this.runDeepDreamOctaves(this.parameters, epoch);
    return true;
  }

  setClockRunning(enabled) {
    this.clockEnabled = Boolean(enabled);
    if (!this.clockEnabled) this.stop();
    else if (this.ready && this.mode !== "original") this.requestStart();
  }

  // The graph accepts [0, 1] RGB pixels and performs InceptionV3
  // preprocessing internally before exposing Mixed_6a and Mixed_6c.
  async runDeepDreamOctaves(parameters, epoch = this.engineConfigurationEpoch) {
    if (
      !this.ready ||
      !this.sourceTensor ||
      this.isOctaveRunning ||
      epoch !== this.engineConfigurationEpoch
    )
      return false;
    const tf = globalThis.tf;
    const reducedCompute = this.pipelineMode(parameters) === PREVIEW_PIPELINE;
    const requestedOctaves = clamp(
      parseInt(parameters?.octaveCount || "5", 10),
      2,
      5,
    );
    const requestedSteps = clamp(
      parseInt(parameters?.stepsPerOctave || "50", 10),
      10,
      50,
    );
    const numOctaves = reducedCompute
      ? Math.min(3, requestedOctaves)
      : requestedOctaves;
    const stepsPerOctave = reducedCompute
      ? Math.min(20, requestedSteps)
      : requestedSteps;
    const maxJitter = clamp(
      parseInt(parameters?.spatialJitter ?? "16", 10),
      0,
      32,
    );
    const smoothness = clamp(Number(parameters?.smoothness ?? 0.15), 0, 0.5);
    const colorMode = parameters?.colorMode === "vivid" ? "vivid" : "natural";
    const frequencyBand = parameters?.frequencyBand || "high_freq_texture";
    const previewInterval = reducedCompute ? 4 : 10;
    const stepSize =
      clamp(Number(parameters?.dreamStrength ?? 1), 0.2, 2.0) * 0.01;
    const targetNodes = this.resolveTargetNodes();

    if (!targetNodes.length) {
      this.progressStatus = "MIXED_6A / MIXED_6C OUTPUTS UNAVAILABLE";
      if (epoch === this.engineConfigurationEpoch) this.isRunning = false;
      return false;
    }

    this.isOctaveRunning = true;
    this.octaveAborted = false;
    const configuration = this.lastDreamConfiguration;
    const sourceEpoch = this.resetEpoch;
    const checkpoint = this.octaveCheckpoint;
    this.octaveCheckpoint = null;
    if (!checkpoint) this.stepCount = 0;
    const startTime = performance.now();
    const octaveScale = 1.3;
    const baseH = this.workingHeight;
    const baseW = this.workingWidth;
    const octavePowers = Array.from(
      { length: numOctaves },
      (_, index) => index - Math.floor(numOctaves / 2),
    );
    const maxOctaveScale = Math.pow(
      octaveScale,
      octavePowers[octavePowers.length - 1],
    );
    const peakH = Math.max(128, Math.round((baseH * maxOctaveScale) / 8) * 8);
    const peakW = Math.max(128, Math.round((baseW * maxOctaveScale) / 8) * 8);

    let peakSourceTensor = null;
    let activeOctaveMask = null;
    let image = checkpoint?.image || null;
    let octaveIndex = checkpoint?.octaveIndex || 0;
    let nextStep = checkpoint?.nextStep || 1;
    let failed = false;

    try {
      await this.requireGpu([this.verifiedBackend || "webgl"]);
      if (epoch !== this.engineConfigurationEpoch) return false;

      if (this.sourceImage) {
        const peakCanvas = document.createElement("canvas");
        peakCanvas.width = peakW;
        peakCanvas.height = peakH;
        const pCtx = peakCanvas.getContext("2d", { alpha: false });
        pCtx.fillStyle = "#000000";
        pCtx.fillRect(0, 0, peakW, peakH);
        drawContain(pCtx, this.sourceImage, peakW, peakH);
        peakSourceTensor = tf.tidy(() =>
          tf.browser.fromPixels(peakCanvas).toFloat().div(255).expandDims(0),
        );
      }

      for (; octaveIndex < octavePowers.length; octaveIndex += 1) {
        if (
          this.octaveAborted ||
          !this.isRunning ||
          epoch !== this.engineConfigurationEpoch
        )
          break;

        const scale = Math.pow(octaveScale, octavePowers[octaveIndex]);
        const octaveH = Math.max(128, Math.round((baseH * scale) / 8) * 8);
        const octaveW = Math.max(128, Math.round((baseW * scale) / 8) * 8);

        activeOctaveMask?.dispose();
        activeOctaveMask = this.computeActiveMask(
          tf,
          octaveH,
          octaveW,
          peakSourceTensor || this.sourceTensor,
        );

        if (
          !image ||
          image.shape[1] !== octaveH ||
          image.shape[2] !== octaveW
        ) {
          const resized = tf.tidy(() => {
            const src = peakSourceTensor || this.sourceTensor;
            if (!image) {
              const base =
                this.totalSteps > 0 && this.dreamTensor
                  ? this.dreamTensor
                  : src;
              return tf.image.resizeBilinear(base, [octaveH, octaveW]);
            }
            return upscaleWithDetail(tf, image, src, octaveH, octaveW);
          });
          image?.dispose();
          image = resized;
        }

        for (let step = nextStep; step <= stepsPerOctave; step += 1) {
          if (
            this.octaveAborted ||
            !this.isRunning ||
            epoch !== this.engineConfigurationEpoch
          )
            break;
          this.stepCount += 1;
          this.totalSteps += 1;
          const depthLabel = getDepthLabel(parameters?.targetDepth);
          this.progressStatus = `OCTAVE ${octaveIndex + 1}/${numOctaves} · ASCENT ${step}/${stepsPerOctave} · TOTAL: ${this.totalSteps} · ${depthLabel}`;

          let shiftY = 0;
          let shiftX = 0;
          if (maxJitter > 0) {
            shiftY = Math.floor((Math.random() * 2 - 1) * maxJitter);
            shiftX = Math.floor((Math.random() * 2 - 1) * maxJitter);
          }

          const nextImage = tf.tidy(() => {
            const jittered =
              maxJitter > 0 ? roll2D(tf, image, shiftY, shiftX) : image;

            const lossFn = (inputTensor) => {
              const raw = this.model.execute(inputTensor, targetNodes);
              const activations = Array.isArray(raw) ? raw : [raw];
              const losses = activations
                .filter(Boolean)
                .map((activation) => this.activationLoss(activation));
              const featureLoss =
                losses.length === 1 ? losses[0] : tf.addN(losses);
              if (smoothness > 0.001) {
                const reg = calcTvLoss(tf, inputTensor).mul(smoothness * 2.0);
                return featureLoss.sub(reg);
              }
              return featureLoss;
            };

            const { value, grad } = tf.valueAndGrad(lossFn)(jittered);
            value.dispose();
            if (!grad) return image.clone();

            const unrolledGrad =
              maxJitter > 0 ? roll2D(tf, grad, -shiftY, -shiftX) : grad;

            const normalizedGradient = this.normalizeGradient(unrolledGrad);
            const stepDelta = normalizedGradient.mul(stepSize);
            const maskedDelta = activeOctaveMask
              ? stepDelta.mul(activeOctaveMask)
              : stepDelta;
            let updated = image
              .add(maskedDelta)
              .clipByValue(0, 1);

            if (colorMode === "natural" && this.sourceTensor) {
              updated = matchSourceColor(
                tf,
                updated,
                peakSourceTensor || this.sourceTensor,
                0.85,
              );
            }

            if (frequencyBand !== "full") {
              updated = applyFrequencyBandFilter(
                tf,
                updated,
                peakSourceTensor || this.sourceTensor,
                frequencyBand,
              );
            }

            // Zero-bleed synthesis anchoring: strictly anchor unmasked pixels to original source
            if (activeOctaveMask && (peakSourceTensor || this.sourceTensor)) {
              const baseSrc = tf.image.resizeBilinear(
                peakSourceTensor || this.sourceTensor,
                [octaveH, octaveW],
              );
              updated = tf.add(
                updated.mul(activeOctaveMask),
                baseSrc.mul(tf.sub(1.0, activeOctaveMask)),
              );
            }

            return updated;
          });

          image.dispose();
          image = nextImage;
          nextStep = step + 1;

          if (step % previewInterval === 0 || step === stepsPerOctave) {
            if (
              this.previewCanvas.width !== octaveW ||
              this.previewCanvas.height !== octaveH
            ) {
              this.previewCanvas.width = octaveW;
              this.previewCanvas.height = octaveH;
            }
            if (
              this.dreamCanvas.width !== octaveW ||
              this.dreamCanvas.height !== octaveH
            ) {
              this.dreamCanvas.width = octaveW;
              this.dreamCanvas.height = octaveH;
            }
            const preview = tf.tidy(() => image.squeeze([0]));
            try {
              await tf.browser.toPixels(preview, this.previewCanvas);
              if (epoch === this.engineConfigurationEpoch && this.isRunning) {
                this.dreamCanvas
                  .getContext("2d", { alpha: false })
                  .drawImage(this.previewCanvas, 0, 0);
                this.onStateChange?.();
                if (this.presentationCanvas) {
                  const fusionAlpha = Number(
                    parameters?.detailFusion ??
                      this.parameters?.detailFusion ??
                      0.22,
                  );
                  drawSharpenedContain(
                    this.presentationCanvas.getContext("2d", { alpha: false }),
                    this.dreamCanvas,
                    this.sourceImage || this.sourceCanvas,
                    this.presentationCanvas.width,
                    this.presentationCanvas.height,
                    fusionAlpha,
                  );
                }
              }
            } finally {
              preview.dispose();
            }
          }

          // Keep input, controls, and cancellation responsive between GPU steps.
          await tf.nextFrame();
        }
        if (
          this.octaveAborted ||
          !this.isRunning ||
          epoch !== this.engineConfigurationEpoch
        )
          break;
        nextStep = 1;
      }

      if (
        !this.octaveAborted &&
        epoch === this.engineConfigurationEpoch &&
        image
      ) {
        const [, finalH, finalW] = image.shape;
        const finalTensor = tf.tidy(() => image.clone().clipByValue(0, 1));
        const stagingCanvas = document.createElement("canvas");
        stagingCanvas.width = finalW;
        stagingCanvas.height = finalH;
        const frame = finalTensor.squeeze([0]);
        try {
          await tf.browser.toPixels(frame, stagingCanvas);
        } finally {
          frame.dispose();
        }

        if (epoch !== this.engineConfigurationEpoch || !this.isRunning) {
          finalTensor.dispose();
          return false;
        }

        this.dreamTensor?.dispose();
        this.dreamTensor = finalTensor;
        this.dreamCanvas.width = finalW;
        this.dreamCanvas.height = finalH;
        this.dreamCanvas
          .getContext("2d", { alpha: false })
          .drawImage(stagingCanvas, 0, 0);
        this.benchmarkMs = performance.now() - startTime;
        this.octaveDone = true;
        const depthLabel = getDepthLabel(parameters?.targetDepth);
        this.progressStatus = `ASCENT COMPLETE · ${finalW}×${finalH} · TOTAL STEPS: ${this.totalSteps} · ${depthLabel}`;
        this.isRunning = false;
        if (this.presentationCanvas) {
          const fusionAlpha = Number(
            parameters?.detailFusion ?? this.parameters?.detailFusion ?? 0.22,
          );
          drawSharpenedContain(
            this.presentationCanvas.getContext("2d", { alpha: false }),
            this.dreamCanvas,
            this.sourceImage || this.sourceCanvas,
            this.presentationCanvas.width,
            this.presentationCanvas.height,
            fusionAlpha,
          );
        }
      }
    } catch (error) {
      failed = true;
      if (epoch === this.engineConfigurationEpoch) {
        console.error("[Inception Dream] Octave engine failed:", error);
        this.progressStatus = "SYNTHESIS FAILED";
        this.loadError = error.message;
      }
    } finally {
      activeOctaveMask?.dispose();
      activeOctaveMask = null;
      if (peakSourceTensor && peakSourceTensor !== this.sourceTensor) {
        peakSourceTensor.dispose();
      }
      // A navigation/tab pause retains exactly one tensor. Configuration changes,
      // source replacement, reset, and disposal invalidate it instead.
      if (
        image &&
        !failed &&
        !this.octaveDone &&
        sourceEpoch === this.resetEpoch &&
        configuration === this.lastDreamConfiguration
      ) {
        this.clearCheckpoint();
        this.octaveCheckpoint = { image, octaveIndex, nextStep };
        image = null;
      }
      image?.dispose();
      this.isOctaveRunning = false;
      if (epoch === this.engineConfigurationEpoch) this.isRunning = false;
      this.onStateChange?.();
    }
    return true;
  }

  async dreamMore(additionalSteps = 15) {
    if (
      !this.ready ||
      this.isOctaveRunning ||
      this.isResetting ||
      !this.sourceLoaded
    )
      return false;

    const tf = globalThis.tf;
    const steps = clamp(Number(additionalSteps) || 15, 1, 50);
    const maxJitter = clamp(
      parseInt(this.parameters?.spatialJitter ?? "16", 10),
      0,
      32,
    );
    const smoothness = clamp(
      Number(this.parameters?.smoothness ?? 0.15),
      0,
      0.5,
    );
    const colorMode =
      this.parameters?.colorMode === "vivid" ? "vivid" : "natural";
    const frequencyBand =
      this.parameters?.frequencyBand || "high_freq_texture";
    const stepSize =
      clamp(Number(this.parameters?.dreamStrength ?? 1), 0.2, 2.0) * 0.01;
    const targetNodes = this.resolveTargetNodes();
    if (!targetNodes.length) return false;

    this.mode = "dream";
    this.isPaused = false;
    this.isRunning = true;
    this.isOctaveRunning = true;
    this.octaveAborted = false;
    this.clearCheckpoint();

    const epoch = ++this.engineConfigurationEpoch;
    const currentTensor = this.dreamTensor || this.sourceTensor;
    const currentH = currentTensor.shape[1];
    const currentW = currentTensor.shape[2];

    let image = currentTensor.clone();
    let continuationMask = null;

    try {
      await this.requireGpu([this.verifiedBackend || "webgl"]);
      continuationMask = this.computeActiveMask(
        tf,
        currentH,
        currentW,
        this.sourceTensor,
      );

      for (let step = 1; step <= steps; step += 1) {
        if (
          this.octaveAborted ||
          !this.isRunning ||
          epoch !== this.engineConfigurationEpoch
        )
          break;

        this.stepCount += 1;
        this.totalSteps += 1;
        const depthLabel = getDepthLabel(this.parameters?.targetDepth);
        this.progressStatus = `CONTINUATION ${step}/${steps} · TOTAL: ${this.totalSteps} · ${depthLabel}`;

        let shiftY = 0;
        let shiftX = 0;
        if (maxJitter > 0) {
          shiftY = Math.floor((Math.random() * 2 - 1) * maxJitter);
          shiftX = Math.floor((Math.random() * 2 - 1) * maxJitter);
        }

        const nextImage = tf.tidy(() => {
          const jittered =
            maxJitter > 0 ? roll2D(tf, image, shiftY, shiftX) : image;

          const lossFn = (inputTensor) => {
            const raw = this.model.execute(inputTensor, targetNodes);
            const activations = Array.isArray(raw) ? raw : [raw];
            const losses = activations
              .filter(Boolean)
              .map((activation) => this.activationLoss(activation));
            const featureLoss =
              losses.length === 1 ? losses[0] : tf.addN(losses);
            if (smoothness > 0.001) {
              const reg = calcTvLoss(tf, inputTensor).mul(smoothness * 2.0);
              return featureLoss.sub(reg);
            }
            return featureLoss;
          };

          const { value, grad } = tf.valueAndGrad(lossFn)(jittered);
          value.dispose();
          if (!grad) return image.clone();

          const unrolledGrad =
            maxJitter > 0 ? roll2D(tf, grad, -shiftY, -shiftX) : grad;

          const normalizedGradient = this.normalizeGradient(unrolledGrad);
          const stepDelta = normalizedGradient.mul(stepSize);
          const maskedDelta = continuationMask
            ? stepDelta.mul(continuationMask)
            : stepDelta;
          let updated = image
            .add(maskedDelta)
            .clipByValue(0, 1);

          if (colorMode === "natural" && this.sourceTensor) {
            updated = matchSourceColor(tf, updated, this.sourceTensor, 0.85);
          }

          if (frequencyBand !== "full" && this.sourceTensor) {
            updated = applyFrequencyBandFilter(
              tf,
              updated,
              this.sourceTensor,
              frequencyBand,
            );
          }

          // Zero-bleed synthesis anchoring: strictly anchor unmasked pixels to original source
          if (continuationMask && this.sourceTensor) {
            const baseSrc = tf.image.resizeBilinear(
              this.sourceTensor,
              [currentH, currentW],
            );
            updated = tf.add(
              updated.mul(continuationMask),
              baseSrc.mul(tf.sub(1.0, continuationMask)),
            );
          }

          return updated;
        });

        image.dispose();
        image = nextImage;

        if (step % 3 === 0 || step === steps) {
          if (
            this.previewCanvas.width !== currentW ||
            this.previewCanvas.height !== currentH
          ) {
            this.previewCanvas.width = currentW;
            this.previewCanvas.height = currentH;
          }
          if (
            this.dreamCanvas.width !== currentW ||
            this.dreamCanvas.height !== currentH
          ) {
            this.dreamCanvas.width = currentW;
            this.dreamCanvas.height = currentH;
          }
          const preview = tf.tidy(() => image.squeeze([0]));
          try {
            await tf.browser.toPixels(preview, this.previewCanvas);
            if (epoch === this.engineConfigurationEpoch && this.isRunning) {
              this.dreamCanvas
                .getContext("2d", { alpha: false })
                .drawImage(this.previewCanvas, 0, 0);
              this.onStateChange?.();
              if (this.presentationCanvas) {
                const fusionAlpha = Number(
                  this.parameters?.detailFusion ?? 0.22,
                );
                drawSharpenedContain(
                  this.presentationCanvas.getContext("2d", { alpha: false }),
                  this.dreamCanvas,
                  this.sourceImage || this.sourceCanvas,
                  this.presentationCanvas.width,
                  this.presentationCanvas.height,
                  fusionAlpha,
                );
              }
            }
          } finally {
            preview.dispose();
          }
        }

        await tf.nextFrame();
      }

      if (
        !this.octaveAborted &&
        epoch === this.engineConfigurationEpoch &&
        image
      ) {
        const finalTensor = tf.tidy(() => image.clone().clipByValue(0, 1));
        const stagingCanvas = document.createElement("canvas");
        stagingCanvas.width = currentW;
        stagingCanvas.height = currentH;
        const frame = finalTensor.squeeze([0]);
        try {
          await tf.browser.toPixels(frame, stagingCanvas);
        } finally {
          frame.dispose();
        }

        if (epoch !== this.engineConfigurationEpoch || !this.isRunning) {
          finalTensor.dispose();
          return false;
        }

        this.dreamTensor?.dispose();
        this.dreamTensor = finalTensor;
        this.dreamCanvas.width = currentW;
        this.dreamCanvas.height = currentH;
        this.dreamCanvas
          .getContext("2d", { alpha: false })
          .drawImage(stagingCanvas, 0, 0);
        this.octaveDone = true;
        const depthLabel = getDepthLabel(this.parameters?.targetDepth);
        this.progressStatus = `ASCENT COMPLETE · ${currentW}×${currentH} · TOTAL STEPS: ${this.totalSteps} · ${depthLabel}`;
        this.isRunning = false;
        if (this.presentationCanvas) {
          const fusionAlpha = Number(
            this.parameters?.detailFusion ?? 0.22,
          );
          drawSharpenedContain(
            this.presentationCanvas.getContext("2d", { alpha: false }),
            this.dreamCanvas,
            this.sourceImage || this.sourceCanvas,
            this.presentationCanvas.width,
            this.presentationCanvas.height,
            fusionAlpha,
          );
        }
      }
    } catch (error) {
      if (epoch === this.engineConfigurationEpoch) {
        console.error("[Inception Dream] Continuation failed:", error);
        this.progressStatus = "SYNTHESIS FAILED";
        this.loadError = error.message;
      }
    } finally {
      continuationMask?.dispose();
      image?.dispose();
      this.isOctaveRunning = false;
      this.clockEnabled = false;
      if (epoch === this.engineConfigurationEpoch) this.isRunning = false;
      this.onStateChange?.();
    }
    return true;
  }

  async render(canvas, parameters) {
    this.presentationCanvas = canvas;
    this.parameters = parameters;
    this.synchronizeDreamConfiguration(parameters);

    const reducedCompute = this.pipelineMode(parameters) === PREVIEW_PIPELINE;
    const profile = parameters?.resolutionProfile || "balanced";
    let baseTarget;
    switch (profile) {
      case "compact":
        baseTarget = 320;
        break;
      case "high":
        baseTarget = 576;
        break;
      case "ultra":
        baseTarget = 672;
        break;
      case "balanced":
      default:
        baseTarget = 448;
        break;
    }
    if (reducedCompute) {
      baseTarget = Math.min(320, baseTarget);
    }
    this.computeMax = baseTarget;
    this.setDimensions(canvas.width, canvas.height, baseTarget);
    if (!this.sourceLoaded) {
      drawDiagnostic(canvas, "INCEPTION DREAM", "CHOOSE AN IMAGE TO BEGIN");
      return {
        backend: this.backend,
        status: "waiting",
        modelMetrics: { status: "WAITING_IMAGE" },
        inferenceMs: 0,
      };
    }

    if (!this.ready) {
      drawDiagnostic(
        canvas,
        "MODEL NOT LOADED",
        "Select LOAD MODEL to initialize InceptionV3.",
      );
      return {
        backend: this.backend,
        status: "waiting",
        modelMetrics: { status: "MODEL_NOT_READY" },
        inferenceMs: 0,
      };
    }

    const started = performance.now();
    const ctx = canvas.getContext("2d", { alpha: false });

    if (this.mode === "original") {
      this.stop();
      drawContain(ctx, this.sourceCanvas, canvas.width, canvas.height);
    } else {
      const fusionAlpha = Number(
        parameters?.detailFusion ?? this.parameters?.detailFusion ?? 0.22,
      );
      drawSharpenedContain(
        ctx,
        this.dreamCanvas,
        this.sourceImage || this.sourceCanvas,
        canvas.width,
        canvas.height,
        fusionAlpha,
      );

      // Draw active octave progress overlay
      if (this.isOctaveRunning) {
        ctx.save();
        ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
        ctx.fillRect(0, canvas.height - 34, canvas.width, 34);
        ctx.fillStyle = "#a78bfa";
        ctx.font = "12px monospace";
        ctx.fillText(this.progressStatus, 16, canvas.height - 12);
        ctx.restore();
      }

      if (!this.isRunning && this.clockEnabled && !this.isResetting && !this.isPaused)
        this.requestStart();
    }

    const mem = globalThis.tf?.memory?.();
    return {
      backend: this.backend,
      status: this.loadError
        ? "error"
        : this.isRunning
          ? "processing"
          : "ready",
      modelMetrics: {
        model: "InceptionV3",
        profile: reducedCompute ? "REDUCED COMPUTE" : "QUALITY",
        status: this.isOctaveRunning
          ? this.progressStatus
          : this.octaveDone
            ? "FEATURE MAP READY"
            : "IDLE",
        resolution: this.dreamCanvas?.width
          ? `${this.dreamCanvas.width}×${this.dreamCanvas.height}`
          : `${this.workingWidth}×${this.workingHeight}`,
        steps: this.stepCount,
        vramMB: mem?.numBytesInGPU
          ? (mem.numBytesInGPU / 1048576).toFixed(1)
          : "N/A",
        tensors: mem?.numTensors ?? 0,
      },
      inferenceMs: this.benchmarkMs || performance.now() - started,
    };
  }

  drawSharpenedContain(
    context,
    dreamSource,
    photoSource,
    width,
    height,
    fusionAlpha = 0.22,
  ) {
    return drawSharpenedContain(
      context,
      dreamSource,
      photoSource,
      width,
      height,
      fusionAlpha,
    );
  }

  async synthesizeTile(
    tf,
    tileCanvas,
    tileSourceCanvas,
    tileMaskCanvas,
    options = {},
  ) {
    const steps = Math.max(1, Number(options.steps || 10));
    const stepSize =
      clamp(Number(options.dreamStrength ?? 1.0), 0.2, 2.0) * 0.015;
    const smoothness = clamp(Number(options.smoothness ?? 0.15), 0, 0.5);
    const maxJitter = clamp(
      parseInt(options.spatialJitter ?? "16", 10),
      0,
      32,
    );
    const colorMode = options.colorMode === "vivid" ? "vivid" : "natural";
    const frequencyBand = options.frequencyBand || "high_freq_texture";
    const targetNodes = options.targetNodes || this.resolveTargetNodes(options);

    let image = tf.browser
      .fromPixels(tileCanvas)
      .toFloat()
      .div(255)
      .expandDims(0);

    let tileSourceTensor = null;
    if (tileSourceCanvas) {
      tileSourceTensor = tf.browser
        .fromPixels(tileSourceCanvas)
        .toFloat()
        .div(255)
        .expandDims(0);
    }

    let tileMaskTensor = null;
    if (tileMaskCanvas) {
      tileMaskTensor = tf.tidy(() => {
        const raw = tf.browser.fromPixels(tileMaskCanvas).toFloat().div(255);
        return raw.slice([0, 0, 0], [-1, -1, 1]).expandDims(0);
      });
    }

    try {
      for (let s = 0; s < steps; s++) {
        let shiftY = 0;
        let shiftX = 0;
        if (maxJitter > 0) {
          shiftY = Math.floor((Math.random() * 2 - 1) * maxJitter);
          shiftX = Math.floor((Math.random() * 2 - 1) * maxJitter);
        }

        const nextImage = tf.tidy(() => {
          const jittered =
            maxJitter > 0 ? roll2D(tf, image, shiftY, shiftX) : image;

          const lossFn = (inputTensor) => {
            const raw = this.model.execute(inputTensor, targetNodes);
            const activations = Array.isArray(raw) ? raw : [raw];
            const losses = activations
              .filter(Boolean)
              .map((activation) => this.activationLoss(activation));
            const featureLoss =
              losses.length === 1 ? losses[0] : tf.addN(losses);
            if (smoothness > 0.001) {
              const reg = calcTvLoss(tf, inputTensor).mul(smoothness * 2.0);
              return featureLoss.sub(reg);
            }
            return featureLoss;
          };

          const { value, grad } = tf.valueAndGrad(lossFn)(jittered);
          value.dispose();
          if (!grad) return image.clone();

          const unrolledGrad =
            maxJitter > 0 ? roll2D(tf, grad, -shiftY, -shiftX) : grad;

          const normalizedGradient = this.normalizeGradient(unrolledGrad);
          const stepDelta = normalizedGradient.mul(stepSize);
          const maskedDelta = tileMaskTensor
            ? stepDelta.mul(tileMaskTensor)
            : stepDelta;
          let updated = image.add(maskedDelta).clipByValue(0, 1);

          if (colorMode === "natural" && tileSourceTensor) {
            updated = matchSourceColor(tf, updated, tileSourceTensor, 0.85);
          }

          if (frequencyBand !== "full" && tileSourceTensor) {
            updated = applyFrequencyBandFilter(
              tf,
              updated,
              tileSourceTensor,
              frequencyBand,
            );
          }

          if (tileMaskTensor && tileSourceTensor) {
            updated = tf.add(
              updated.mul(tileMaskTensor),
              tileSourceTensor.mul(tf.sub(1.0, tileMaskTensor)),
            );
          }

          return updated;
        });

        image.dispose();
        image = nextImage;
      }

      const preview = tf.tidy(() => image.squeeze([0]));
      await tf.browser.toPixels(preview, tileCanvas);
      preview.dispose();
    } finally {
      image.dispose();
      tileSourceTensor?.dispose();
      tileMaskTensor?.dispose();
    }
  }

  async renderHighRes(outputCanvas, options = {}) {
    if (!outputCanvas || typeof document === "undefined") return false;

    this.stop();
    const parameters = options.parameters || this.parameters || {};
    const targetW = Number(options.width || outputCanvas.width || 2048);
    const targetH = Number(options.height || outputCanvas.height || 2048);
    outputCanvas.width = targetW;
    outputCanvas.height = targetH;

    const tileSize = Number(options.tileSize || 384);
    const overlap = Number(options.overlap || 64);
    const stepsPerTile = Number(options.stepsPerTile || 10);
    const fusionAlpha = Number(parameters.detailFusion ?? 0.22);

    let tf = null;
    try {
      tf = await ensureTensorFlow();
      if (!this.model) await this.ensureModel();
    } catch (err) {
      console.warn(
        "[Inception Dream] Neural model not available for high-res ascent; fallback to high-quality fusion scaling:",
        err,
      );
      const ctx = outputCanvas.getContext("2d", { alpha: false });
      drawSharpenedContain(
        ctx,
        this.dreamCanvas || this.sourceCanvas,
        this.sourceImage || this.sourceCanvas,
        targetW,
        targetH,
        fusionAlpha,
      );
      return true;
    }

    const targetNodes = this.resolveTargetNodes(parameters);
    if (!targetNodes.length || !this.model) {
      const ctx = outputCanvas.getContext("2d", { alpha: false });
      drawSharpenedContain(
        ctx,
        this.dreamCanvas || this.sourceCanvas,
        this.sourceImage || this.sourceCanvas,
        targetW,
        targetH,
        fusionAlpha,
      );
      return true;
    }

    // 1. Prepare initial base working canvas scaled to (targetW, targetH)
    const workingCanvas = document.createElement("canvas");
    workingCanvas.width = targetW;
    workingCanvas.height = targetH;
    const workingCtx = workingCanvas.getContext("2d", { alpha: false });
    workingCtx.fillStyle = "#000";
    workingCtx.fillRect(0, 0, targetW, targetH);
    if (this.dreamCanvas && this.dreamCanvas.width > 0) {
      workingCtx.drawImage(this.dreamCanvas, 0, 0, targetW, targetH);
    } else if (this.sourceImage) {
      workingCtx.drawImage(this.sourceImage, 0, 0, targetW, targetH);
    } else if (this.sourceCanvas) {
      workingCtx.drawImage(this.sourceCanvas, 0, 0, targetW, targetH);
    }

    // 2. Prepare full-resolution source photo canvas for color/detail anchoring
    const sourceFullCanvas = document.createElement("canvas");
    sourceFullCanvas.width = targetW;
    sourceFullCanvas.height = targetH;
    const sfCtx = sourceFullCanvas.getContext("2d", { alpha: false });
    sfCtx.fillStyle = "#000";
    sfCtx.fillRect(0, 0, targetW, targetH);
    if (this.sourceImage) {
      sfCtx.drawImage(this.sourceImage, 0, 0, targetW, targetH);
    } else if (this.sourceCanvas) {
      sfCtx.drawImage(this.sourceCanvas, 0, 0, targetW, targetH);
    }

    // 3. Prepare spatial mask canvas if active
    let maskFullCanvas = null;
    if (this.customMaskActive && this.customMaskCanvas) {
      maskFullCanvas = document.createElement("canvas");
      maskFullCanvas.width = targetW;
      maskFullCanvas.height = targetH;
      const mCtx = maskFullCanvas.getContext("2d");
      mCtx.drawImage(this.customMaskCanvas, 0, 0, targetW, targetH);
    } else if (this.spotlightState.active) {
      maskFullCanvas = document.createElement("canvas");
      maskFullCanvas.width = targetW;
      maskFullCanvas.height = targetH;
      const mCtx = maskFullCanvas.getContext("2d");
      mCtx.fillStyle = "#000";
      mCtx.fillRect(0, 0, targetW, targetH);
      const cx = this.spotlightState.x * targetW;
      const cy = this.spotlightState.y * targetH;
      const scaleFactor = Math.min(
        targetW / this.workingWidth,
        targetH / this.workingHeight,
      );
      const rOuter = Math.max(10, this.spotlightState.radius * scaleFactor);
      const hardness = clamp(
        Number(this.spotlightState.hardness ?? 0.8),
        0.0,
        0.99,
      );
      const rInner = Math.max(0, rOuter * hardness);
      const grad = mCtx.createRadialGradient(cx, cy, rInner, cx, cy, rOuter);
      grad.addColorStop(0, "rgba(255, 255, 255, 1)");
      grad.addColorStop(1, "rgba(255, 255, 255, 0)");
      mCtx.fillStyle = grad;
      mCtx.beginPath();
      mCtx.arc(cx, cy, rOuter, 0, Math.PI * 2);
      mCtx.fill();
      if (this.spotlightState.inverted) {
        mCtx.globalCompositeOperation = "difference";
        mCtx.fillStyle = "#fff";
        mCtx.fillRect(0, 0, targetW, targetH);
      }
    }

    // 4. Compute tile grid and accumulator buffers
    const { tiles, tileWidth: actualTileW, tileHeight: actualTileH } =
      computeTileGrid(targetW, targetH, tileSize, overlap);

    const totalPixels = targetW * targetH;
    const rAccum = new Float32Array(totalPixels);
    const gAccum = new Float32Array(totalPixels);
    const bAccum = new Float32Array(totalPixels);
    const weightAccum = new Float32Array(totalPixels);

    const tileCanvas = document.createElement("canvas");
    tileCanvas.width = actualTileW;
    tileCanvas.height = actualTileH;
    const tileCtx = tileCanvas.getContext("2d", { alpha: false });

    const tileSrcCanvas = document.createElement("canvas");
    tileSrcCanvas.width = actualTileW;
    tileSrcCanvas.height = actualTileH;
    const tileSrcCtx = tileSrcCanvas.getContext("2d", { alpha: false });

    let tileMaskCanvas = null;
    let tileMaskCtx = null;
    if (maskFullCanvas) {
      tileMaskCanvas = document.createElement("canvas");
      tileMaskCanvas.width = actualTileW;
      tileMaskCanvas.height = actualTileH;
      tileMaskCtx = tileMaskCanvas.getContext("2d");
    }

    // 5. Synthesize each tile
    const totalTiles = tiles.length;
    for (let tIdx = 0; tIdx < totalTiles; tIdx++) {
      const { x: tileX, y: tileY, width: tW, height: tH } = tiles[tIdx];

      tileCtx.drawImage(
        workingCanvas,
        tileX,
        tileY,
        tW,
        tH,
        0,
        0,
        actualTileW,
        actualTileH,
      );
      tileSrcCtx.drawImage(
        sourceFullCanvas,
        tileX,
        tileY,
        tW,
        tH,
        0,
        0,
        actualTileW,
        actualTileH,
      );

      let skipTileAscent = false;
      if (maskFullCanvas && tileMaskCtx) {
        tileMaskCtx.clearRect(0, 0, actualTileW, actualTileH);
        tileMaskCtx.drawImage(
          maskFullCanvas,
          tileX,
          tileY,
          tW,
          tH,
          0,
          0,
          actualTileW,
          actualTileH,
        );
        const mData = tileMaskCtx.getImageData(
          0,
          0,
          actualTileW,
          actualTileH,
        ).data;
        let nonZero = 0;
        for (let i = 0; i < mData.length; i += 16) {
          if (mData[i] > 10) {
            nonZero++;
            break;
          }
        }
        if (nonZero === 0) skipTileAscent = true;
      }

      if (!skipTileAscent) {
        await this.synthesizeTile(
          tf,
          tileCanvas,
          tileSrcCanvas,
          maskFullCanvas ? tileMaskCanvas : null,
          {
            ...parameters,
            steps: stepsPerTile,
            targetNodes,
          },
        );
      }

      const tileImgData = tileCtx.getImageData(
        0,
        0,
        actualTileW,
        actualTileH,
      ).data;

      for (let v = 0; v < actualTileH; v++) {
        const wy = Math.sin(((v + 0.5) * Math.PI) / actualTileH);
        const rowOffset = (tileY + v) * targetW;
        for (let u = 0; u < actualTileW; u++) {
          const wx = Math.sin(((u + 0.5) * Math.PI) / actualTileW);
          const weight = Math.pow(wx * wy, 1.2);
          const srcIdx = (v * actualTileW + u) * 4;
          const dstIdx = rowOffset + (tileX + u);

          rAccum[dstIdx] += tileImgData[srcIdx] * weight;
          gAccum[dstIdx] += tileImgData[srcIdx + 1] * weight;
          bAccum[dstIdx] += tileImgData[srcIdx + 2] * weight;
          weightAccum[dstIdx] += weight;
        }
      }

      const current = tIdx + 1;
      const percent = Math.round((current / totalTiles) * 100);
      options.onProgress?.({ current, total: totalTiles, percent });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // 6. Write normalized accumulated pixels to output canvas
    const outCtx = outputCanvas.getContext("2d", { alpha: false });
    const outImageData = outCtx.createImageData(targetW, targetH);
    const outData = outImageData.data;

    for (let i = 0; i < totalPixels; i++) {
      const w = weightAccum[i] || 1.0;
      const oIdx = i * 4;
      outData[oIdx] = Math.min(255, Math.max(0, Math.round(rAccum[i] / w)));
      outData[oIdx + 1] = Math.min(
        255,
        Math.max(0, Math.round(gAccum[i] / w)),
      );
      outData[oIdx + 2] = Math.min(
        255,
        Math.max(0, Math.round(bAccum[i] / w)),
      );
      outData[oIdx + 3] = 255;
    }
    outCtx.putImageData(outImageData, 0, 0);

    // 7. Apply Photographic High-Frequency Detail Fusion on the final output
    if (this.sourceImage && fusionAlpha > 0.001) {
      outCtx.save();
      outCtx.globalCompositeOperation = "soft-light";
      outCtx.globalAlpha = Math.min(0.6, Math.max(0, fusionAlpha));
      outCtx.drawImage(this.sourceImage, 0, 0, targetW, targetH);
      outCtx.restore();
    }

    return true;
  }

  async dispose() {
    this.cancel();
    await this.waitForIdle();
    this.sourceTensor?.dispose();
    this.dreamTensor?.dispose();
    this.sourceTensor = null;
    this.dreamTensor = null;
    if (this.model && typeof this.model.dispose === "function") {
      this.model.dispose();
      this.model = null;
    }
  }
}
