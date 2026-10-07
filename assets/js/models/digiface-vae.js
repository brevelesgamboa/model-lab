import { ensureOnnxRuntime, onnxRuntimeMode } from "../core/ort-runtime.js";
import { clamp, gaussian, mulberry32 } from "../core/utils.js";

const LATENT_DIM = 48;
const MODEL_SIZE = 112;
const MODEL_URL = "./models/digiface/digiface_decoder.onnx";

const AXIS_OPTIONS = Array.from({ length: LATENT_DIM }, (_, index) => ({
  value: index,
  label: `Z${String(index).padStart(2, "0")}`,
}));

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / Math.max(1e-6, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) * 0.5;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0);
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    default:
      h = (r - g) / d + 4;
      break;
  }
  return [h / 6, s, l];
}

function hueToRgb(p, q, t) {
  let value = t;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;
  if (value < 1 / 6) return p + (q - p) * 6 * value;
  if (value < 1 / 2) return q;
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  if (s <= 1e-6) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hueToRgb(p, q, h + 1 / 3),
    hueToRgb(p, q, h),
    hueToRgb(p, q, h - 1 / 3),
  ];
}

function circularHueMix(source, target, amount) {
  let delta = target - source;
  if (delta > 0.5) delta -= 1;
  if (delta < -0.5) delta += 1;
  let result = source + delta * amount;
  if (result < 0) result += 1;
  if (result >= 1) result -= 1;
  return result;
}

function skinLikelihood(r, g, b, x, y) {
  // DigiFace images are centered portraits, so the ellipse is deliberately
  // geometric instead of pretending we have a semantic face-segmentation net.
  const dx = (x - 0.5) / 0.34;
  const dy = (y - 0.51) / 0.44;
  const ellipse = 1 - smoothstep(0.72, 1.03, Math.sqrt(dx * dx + dy * dy));
  if (ellipse <= 0) return 0;

  const [h, s, l] = rgbToHsl(r, g, b);
  const warmHue = h <= 0.18 || h >= 0.94;
  const chromaGate = warmHue
    ? 1
    : smoothstep(0.22, 0.02, Math.min(Math.abs(h - 0.08), Math.abs(h - 1.08)));
  const luminanceGate =
    smoothstep(0.025, 0.12, l) * (1 - smoothstep(0.93, 1.0, l));
  const saturationGate = 0.45 + 0.55 * smoothstep(0.01, 0.2, s);
  return clamp(ellipse * chromaGate * luminanceGate * saturationGate);
}

function applySkinColor(imageData, parameters) {
  const strength = clamp(parameters.skinStrength, 0, 1);
  const saturationScale = clamp(parameters.skinSaturation, 0, 2);
  const lightnessShift = clamp(parameters.skinLightness, -0.5, 0.5);
  if (
    strength <= 0.0001 &&
    Math.abs(saturationScale - 1) <= 0.0001 &&
    Math.abs(lightnessShift) <= 0.0001
  )
    return;

  const targetHue = (((Number(parameters.skinHue) % 360) + 360) % 360) / 360;
  const { data, width, height } = imageData;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const r = data[index] / 255;
      const g = data[index + 1] / 255;
      const b = data[index + 2] / 255;
      const mask = skinLikelihood(
        r,
        g,
        b,
        (x + 0.5) / width,
        (y + 0.5) / height,
      );
      if (mask <= 0.002) continue;

      let [h, s, l] = rgbToHsl(r, g, b);
      const hueAmount = strength * mask;
      h = circularHueMix(h, targetHue, hueAmount);
      s = clamp(s * (1 + (saturationScale - 1) * mask));
      l = clamp(l + lightnessShift * mask);
      const [nr, ng, nb] = hslToRgb(h, s, l);
      data[index] = Math.round(nr * 255);
      data[index + 1] = Math.round(ng * 255);
      data[index + 2] = Math.round(nb * 255);
    }
  }
}

function drawDiagnostic(targetCanvas, title, detail) {
  const context = targetCanvas.getContext("2d", { alpha: false });
  const width = targetCanvas.width;
  const height = targetCanvas.height;
  context.save();
  context.fillStyle = "#050506";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(255,255,255,.16)";
  context.lineWidth = Math.max(1, width / 700);
  context.strokeRect(width * 0.08, height * 0.1, width * 0.84, height * 0.8);
  context.fillStyle = "#f4f1f8";
  context.textAlign = "center";
  context.font = `${Math.max(16, width * 0.025)}px monospace`;
  context.fillText(title, width / 2, height * 0.45);
  context.fillStyle = "#a6a0ad";
  context.font = `${Math.max(11, width * 0.015)}px monospace`;
  const lines = String(detail || "").match(/.{1,54}(?:\s|$)/g) || [];
  lines.slice(0, 4).forEach((line, index) => {
    context.fillText(
      line.trim(),
      width / 2,
      height * 0.52 + index * Math.max(16, width * 0.025),
    );
  });
  context.restore();
}

function makeBaseLatent(seed, temperature) {
  const random = mulberry32(Math.round(clamp(seed, 1, 999999)));
  const latent = new Float32Array(LATENT_DIM);
  const scale = clamp(temperature, 0, 3);
  for (let index = 0; index < LATENT_DIM; index += 1) {
    latent[index] = gaussian(random) * scale;
  }
  return latent;
}

function applyAxis(latent, axisValue, amountValue) {
  const axis = Math.round(clamp(axisValue, 0, LATENT_DIM - 1));
  const amount = clamp(amountValue, -4, 4);
  latent[axis] += amount;
}

export class DigiFaceVaeModel {
  constructor() {
    this.session = null;
    this.sessionPromise = null;
    this.sessionBackend = "ONNX RUNTIME WEB / INITIALIZING";
    this.loadError = null;
    this.modelState = "UNCHECKED";
    this.selfCheckPromise = null;
    this.selfCheckResult = null;
    this.generation = 0;
    this.sourceCanvas = document.createElement("canvas");
    this.sourceCanvas.width = MODEL_SIZE;
    this.sourceCanvas.height = MODEL_SIZE;
  }

  get id() {
    return "digiface-vae";
  }

  get name() {
    return "DigiFace Generator";
  }

  get family() {
    return "BETA-VAE / LEARNED RGB LATENT SPACE";
  }

  get backend() {
    return this.sessionBackend;
  }

  get description() {
    return "A locally executed 48-dimensional beta-VAE decoder trained separately on DigiFace research images. The semantic controls deliberately expose which latent axis is being used so feature entanglement stays visible instead of being hidden.";
  }

  get technicalInfo() {
    return {
      title: "DigiFace Generator",
      architecture: "β-VAE",
      trainingSet: "DigiFace-1M research subset",
      datasetIdentities: "2,000",
      datasetImages: "144,000",
      trainingResolution: "112 × 112 RGB",
      latentDimensions: "48",
      epochs: "60",
      browserInput: "1 × 48 FLOAT32",
      browserOutput: "1 × 3 × 112 × 112",
      trainingFramework: "PyTorch + ROCm",
      trainingHardware: "AMD Radeon RX 6700 XT",
      inferenceFramework: "ONNX Runtime Web",
      inferenceBackend: "WASM / WebGPU (browser-dependent)",
    };
  }

  get animated() {
    return true;
  }

  get available() {
    return true;
  }

  get pixelated() {
    return false;
  }

  isDynamic() {
    return false;
  }

  cancel() {
    this.generation += 1;
  }

  get controls() {
    return [
      {
        key: "seed",
        label: "IDENTITY SEED",
        type: "number",
        min: 1,
        max: 999999,
        step: 1,
        default: 41027,
      },
      {
        key: "temperature",
        label: "LATENT TEMPERATURE",
        type: "range",
        min: 0,
        max: 3,
        step: 0.01,
        fineStep: 0.002,
        default: 1,
        format: "decimal2",
        help: "1.0 samples the learned prior. Larger values move farther from typical latent regions.",
      },

      {
        key: "eyeAxis",
        label: "EYE REGION AXIS",
        type: "select",
        options: AXIS_OPTIONS,
        default: 0,
      },
      {
        key: "eyeAmount",
        label: "EYE REGION AMOUNT",
        type: "range",
        min: -4,
        max: 4,
        step: 0.01,
        fineStep: 0.002,
        default: 0,
        format: "decimal2",
      },
      {
        key: "noseAxis",
        label: "NOSE REGION AXIS",
        type: "select",
        options: AXIS_OPTIONS,
        default: 1,
      },
      {
        key: "noseAmount",
        label: "NOSE REGION AMOUNT",
        type: "range",
        min: -4,
        max: 4,
        step: 0.01,
        fineStep: 0.002,
        default: 0,
        format: "decimal2",
      },
      {
        key: "mouthAxis",
        label: "MOUTH REGION AXIS",
        type: "select",
        options: AXIS_OPTIONS,
        default: 2,
      },
      {
        key: "mouthAmount",
        label: "MOUTH REGION AMOUNT",
        type: "range",
        min: -4,
        max: 4,
        step: 0.01,
        fineStep: 0.002,
        default: 0,
        format: "decimal2",
      },
      {
        key: "expressionAxis",
        label: "EXPRESSION AXIS",
        type: "select",
        options: AXIS_OPTIONS,
        default: 3,
      },
      {
        key: "expressionAmount",
        label: "EXPRESSION AMOUNT",
        type: "range",
        min: -4,
        max: 4,
        step: 0.01,
        fineStep: 0.002,
        default: 0,
        format: "decimal2",
      },
      {
        key: "ageAxis",
        label: "AGE-LIKE APPEARANCE AXIS",
        type: "select",
        options: AXIS_OPTIONS,
        default: 4,
      },
      {
        key: "ageAmount",
        label: "AGE-LIKE APPEARANCE",
        type: "range",
        min: -4,
        max: 4,
        step: 0.01,
        fineStep: 0.002,
        default: 0,
        format: "decimal2",
      },
      {
        key: "freeAxis",
        label: "FREE LATENT AXIS",
        type: "select",
        options: AXIS_OPTIONS,
        default: 5,
      },
      {
        key: "freeAmount",
        label: "FREE LATENT AMOUNT",
        type: "range",
        min: -4,
        max: 4,
        step: 0.01,
        fineStep: 0.002,
        default: 0,
        format: "decimal2",
      },

      {
        key: "skinStrength",
        label: "SKIN COLOR MIX",
        type: "range",
        min: 0,
        max: 1,
        step: 0.01,
        fineStep: 0.002,
        default: 0,
        format: "percent",
        help: "Post-process color transform. Zero preserves the decoder output exactly.",
      },
      {
        key: "skinHue",
        label: "SKIN HUE",
        type: "range",
        min: 0,
        max: 360,
        step: 1,
        fineStep: 0.1,
        default: 28,
        format: "decimal1",
      },
      {
        key: "skinSaturation",
        label: "SKIN SATURATION",
        type: "range",
        min: 0,
        max: 2,
        step: 0.01,
        fineStep: 0.002,
        default: 1,
        format: "decimal2",
      },
      {
        key: "skinLightness",
        label: "SKIN LIGHTNESS",
        type: "range",
        min: -0.5,
        max: 0.5,
        step: 0.01,
        fineStep: 0.002,
        default: 0,
        format: "decimal2",
      },
    ];
  }

  configureRuntime(ort) {
    if (ort.env?.wasm) {
      // The bundled ESM runtime resolves its own WASM binary relative to
      // ort.webgpu.bundle.min.mjs, which is copied into the same directory.
      // Avoid overriding wasmPaths here because doing so forces ONNX Runtime
      // back into its dynamic-module loader.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
    }
    if (ort.env?.webgpu) {
      ort.env.webgpu.powerPreference = "high-performance";
    }
    return ort;
  }

  async createSession() {
    const ort = this.configureRuntime(await ensureOnnxRuntime());
    this.loadError = null;

    if (navigator.gpu && onnxRuntimeMode() === "webgpu") {
      try {
        const session = await ort.InferenceSession.create(MODEL_URL, {
          executionProviders: ["webgpu"],
          graphOptimizationLevel: "all",
        });
        this.sessionBackend = "ONNX RUNTIME WEB / WEBGPU";
        return session;
      } catch (error) {
        console.warn(
          "DIGIFACE WebGPU initialization failed; falling back to WASM.",
          error,
        );
      }
    }

    const session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    this.sessionBackend = "ONNX RUNTIME WEB / WASM CPU";
    return session;
  }

  async ensureSession() {
    if (this.session) return this.session;
    if (!this.sessionPromise) {
      this.sessionPromise = this.createSession()
        .then((session) => {
          this.session = session;
          return session;
        })
        .catch((error) => {
          this.loadError = error;
          this.sessionBackend = "ONNX MODEL FILE REQUIRED";
          throw error;
        })
        .finally(() => {
          this.sessionPromise = null;
        });
    }
    return this.sessionPromise;
  }

  async selfCheck() {
    if (this.modelState === "READY" && this.selfCheckResult) {
      return this.selfCheckResult;
    }

    if (this.selfCheckPromise) return this.selfCheckPromise;

    this.modelState = "CHECKING";

    this.selfCheckPromise = (async () => {
      let inputTensor = null;
      let results = null;
      try {
        const ort = await ensureOnnxRuntime();
        if (!ort) throw new Error("ONNX Runtime is not loaded.");

        const session = await this.ensureSession();
        const inputName = session.inputNames?.[0] || "latent";
        const outputName = session.outputNames?.[0] || "image";

        const zeroLatent = new Float32Array(LATENT_DIM);
        inputTensor = new ort.Tensor("float32", zeroLatent, [1, LATENT_DIM]);
        results = await session.run({ [inputName]: inputTensor });
        const outputTensor = results[outputName] || Object.values(results)[0];

        if (!outputTensor?.data)
          throw new Error(
            "Decoder returned no output tensor during self-check.",
          );

        const dims = Array.from(outputTensor.dims || []);
        const expected = [1, 3, MODEL_SIZE, MODEL_SIZE];
        const correctShape =
          dims.length === expected.length &&
          dims.every((value, index) => Number(value) === expected[index]);

        if (!correctShape) {
          throw new Error(
            `Unexpected output shape [${dims.join(", ")}]. Expected [${expected.join(", ")}].`,
          );
        }

        const expectedValues = 3 * MODEL_SIZE * MODEL_SIZE;
        if (outputTensor.data.length !== expectedValues) {
          throw new Error(
            `Unexpected output size ${outputTensor.data.length}. Expected ${expectedValues} values.`,
          );
        }

        this.modelState = "READY";
        this.loadError = null;
        this.selfCheckResult = {
          state: "READY",
          inputShape: [1, LATENT_DIM],
          outputShape: expected,
          inputType: "FLOAT32",
          backend: this.backend,
        };
        return this.selfCheckResult;
      } catch (error) {
        this.modelState = "ERROR";
        this.loadError = error;
        this.selfCheckResult = null;
        throw error;
      } finally {
        inputTensor?.dispose();
        for (const tensor of Object.values(results || {})) tensor.dispose();
        this.selfCheckPromise = null;
      }
    })();

    return this.selfCheckPromise;
  }

  buildLatent(parameters) {
    const latent = makeBaseLatent(parameters.seed, parameters.temperature);
    applyAxis(latent, parameters.eyeAxis, parameters.eyeAmount);
    applyAxis(latent, parameters.noseAxis, parameters.noseAmount);
    applyAxis(latent, parameters.mouthAxis, parameters.mouthAmount);
    applyAxis(latent, parameters.expressionAxis, parameters.expressionAmount);
    applyAxis(latent, parameters.ageAxis, parameters.ageAmount);
    applyAxis(latent, parameters.freeAxis, parameters.freeAmount);
    return latent;
  }

  tensorToImageData(tensor) {
    const data = tensor.data;
    const dimensions = tensor.dims;
    const height = Number(dimensions?.[2] || MODEL_SIZE);
    const width = Number(dimensions?.[3] || MODEL_SIZE);
    const imageData = new ImageData(width, height);
    const plane = width * height;

    for (let pixel = 0; pixel < plane; pixel += 1) {
      const target = pixel * 4;
      imageData.data[target] = Math.round(clamp(data[pixel]) * 255);
      imageData.data[target + 1] = Math.round(clamp(data[plane + pixel]) * 255);
      imageData.data[target + 2] = Math.round(
        clamp(data[plane * 2 + pixel]) * 255,
      );
      imageData.data[target + 3] = 255;
    }
    return imageData;
  }

  drawOutput(targetCanvas, imageData, parameters) {
    applySkinColor(imageData, parameters);
    const sourceContext = this.sourceCanvas.getContext("2d", { alpha: false });
    if (
      this.sourceCanvas.width !== imageData.width ||
      this.sourceCanvas.height !== imageData.height
    ) {
      this.sourceCanvas.width = imageData.width;
      this.sourceCanvas.height = imageData.height;
    }
    sourceContext.putImageData(imageData, 0, 0);

    const context = targetCanvas.getContext("2d", { alpha: false });
    context.save();
    context.fillStyle = "#000";
    context.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      this.sourceCanvas,
      0,
      0,
      targetCanvas.width,
      targetCanvas.height,
    );
    context.restore();
  }

  async render(targetCanvas, parameters) {
    const started = performance.now();
    const generation = ++this.generation;
    let latentTensor = null;
    let results = null;

    try {
      const ort = await ensureOnnxRuntime();
      await this.selfCheck();
      const session = await this.ensureSession();
      if (generation !== this.generation)
        return { backend: this.backend, modelMetrics: {}, inferenceMs: 0 };

      const latent = this.buildLatent(parameters);
      latentTensor = new ort.Tensor("float32", latent, [1, LATENT_DIM]);
      const inputName = session.inputNames?.[0] || "latent";
      results = await session.run({ [inputName]: latentTensor });
      if (generation !== this.generation)
        return { backend: this.backend, modelMetrics: {}, inferenceMs: 0 };

      const outputName = session.outputNames?.[0] || "image";
      const outputTensor = results[outputName] || Object.values(results)[0];
      if (!outputTensor?.data)
        throw new Error("Decoder returned no output tensor.");

      const imageData = this.tensorToImageData(outputTensor);
      this.drawOutput(targetCanvas, imageData, parameters);

      let latentEnergy = 0;
      for (const value of latent) latentEnergy += value * value;
      latentEnergy = Math.sqrt(latentEnergy / LATENT_DIM);

      return {
        backend: this.backend,
        modelMetrics: {
          modelState: this.modelState,
          inputTensor: `1 × ${LATENT_DIM} FLOAT32`,
          outputTensor: `1 × 3 × ${MODEL_SIZE} × ${MODEL_SIZE}`,
          executionProvider: this.backend.includes("WEBGPU")
            ? "WEBGPU"
            : "WASM",
          latentDimensions: LATENT_DIM,
          modelResolution: MODEL_SIZE,
          latentEnergy,
          skinColorMix: clamp(parameters.skinStrength),
        },
        inferenceMs: performance.now() - started,
      };
    } catch (error) {
      if (generation !== this.generation)
        return { backend: this.backend, status: "cancelled" };
      const detail = error instanceof Error ? error.message : String(error);
      drawDiagnostic(
        targetCanvas,
        "DIGIFACE MODEL NOT READY",
        detail.includes("404") || detail.includes("Failed to fetch")
          ? "Copy digiface_decoder.onnx into models/digiface/ and rebuild the project."
          : detail,
      );
      return {
        backend: this.backend,
        modelMetrics: {
          modelState: "ERROR",
          inputTensor: `1 × ${LATENT_DIM} FLOAT32`,
          outputTensor: `EXPECTED 1 × 3 × ${MODEL_SIZE} × ${MODEL_SIZE}`,
          executionProvider: this.backend.includes("WEBGPU")
            ? "WEBGPU"
            : "WASM",
          latentDimensions: LATENT_DIM,
          modelResolution: MODEL_SIZE,
        },
        inferenceMs: performance.now() - started,
      };
    } finally {
      latentTensor?.dispose();
      for (const tensor of Object.values(results || {})) tensor.dispose();
    }
  }

  async dispose() {
    this.cancel();
    const session =
      this.session || (await this.sessionPromise?.catch(() => null));
    await session?.release();
    this.session = null;
  }
}
