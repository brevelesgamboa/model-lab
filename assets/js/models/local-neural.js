import { NeuralModelStore } from "../core/neural-model-store.js";
import { ensureTensorFlow } from "../training/tf-runtime.js";
import { applyDatamosh } from "../core/datamosh.js";
import { clamp } from "../core/utils.js";

const MODEL_SIZE = 128;

function drawDiagnostic(targetCanvas, title, detail) {
  const context = targetCanvas.getContext("2d", { alpha: false });
  context.save();
  context.fillStyle = "#050506";
  context.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
  context.strokeStyle = "rgba(255,255,255,.16)";
  context.strokeRect(
    targetCanvas.width * 0.08,
    targetCanvas.height * 0.1,
    targetCanvas.width * 0.84,
    targetCanvas.height * 0.8,
  );
  context.fillStyle = "#f4f1f8";
  context.textAlign = "center";
  context.font = `${Math.max(16, targetCanvas.width * 0.025)}px monospace`;
  context.fillText(title, targetCanvas.width / 2, targetCanvas.height * 0.45);
  context.fillStyle = "#a6a0ad";
  context.font = `${Math.max(11, targetCanvas.width * 0.015)}px monospace`;
  const lines = String(detail || "").match(/.{1,56}(?:\s|$)/g) || [];
  lines.slice(0, 4).forEach((line, index) => {
    context.fillText(
      line.trim(),
      targetCanvas.width / 2,
      targetCanvas.height * 0.52 +
        index * Math.max(16, targetCanvas.width * 0.025),
    );
  });
  context.restore();
}

function latentOptions(count) {
  return Array.from({ length: count }, (_, index) => ({
    value: index,
    label: `Z${String(index).padStart(2, "0")}`,
  }));
}

export class LocalNeuralModel {
  constructor() {
    this.metadata = NeuralModelStore.loadMetadata();
    this.models = null;
    this.modelsPromise = null;
    this.generation = 0;
    this.lowCanvas = document.createElement("canvas");
    this.lowCanvas.width = MODEL_SIZE;
    this.lowCanvas.height = MODEL_SIZE;
    this.effectCanvas = document.createElement("canvas");
  }

  reload() {
    this.cancel();
    this.metadata = NeuralModelStore.loadMetadata();
    this.disposeModels();
  }

  disposeModels() {
    if (this.models) {
      this.models.encoder?.dispose?.();
      this.models.decoder?.dispose?.();
    }
    this.models = null;
    this.modelsPromise = null;
  }

  get id() {
    return "local-neural";
  }
  get name() {
    return this.metadata?.name || "Local Neural Model";
  }
  get family() {
    return "Local neural autoencoder";
  }
  get backend() {
    const backend =
      globalThis.tf?.getBackend?.() || this.metadata?.backend || "not loaded";
    return `TENSORFLOW.JS / ${String(backend).toUpperCase()}`;
  }
  get description() {
    if (!this.metadata)
      return "No browser-trained neural model is stored. Build one in Experiments.";
    return `Convolutional autoencoder trained locally from ${this.metadata.trainingSamples} images at 128 × 128 RGB. A square-pixel displacement effect is applied after decoding.`;
  }
  get technicalInfo() {
    if (!this.metadata) return null;
    return {
      title: this.metadata.name,
      architecture:
        "Convolutional autoencoder / pixel displacement post-process",
      trainingSet: "Local user image dataset",
      datasetIdentities: "N/A",
      datasetImages: String(this.metadata.trainingSamples),
      trainingResolution: "128 × 128 RGB",
      latentDimensions: String(this.metadata.latentDim),
      epochs: String(this.metadata.epochs),
      browserInput: "1 × 128 × 128 × 3 FLOAT32",
      browserOutput: "1 × 128 × 128 × 3 FLOAT32",
      trainingFramework: "TensorFlow.js",
      trainingHardware: String(
        this.metadata.backend || "browser backend",
      ).toUpperCase(),
      inferenceFramework: "TensorFlow.js",
      inferenceBackend: "WebGL / CPU",
    };
  }
  get animated() {
    return true;
  }
  get available() {
    return Boolean(this.metadata);
  }
  get pixelated() {
    return true;
  }
  isDynamic(parameters) {
    return Number(parameters?.motion) > 0.001;
  }

  cancel() {
    this.generation += 1;
  }

  get controls() {
    const metadata = this.metadata;
    const sampleNames = metadata?.sampleNames || [];
    const sourceOptions = sampleNames.map((name, index) => ({
      value: index,
      label: `${String(index + 1).padStart(2, "0")} / ${String(name).slice(0, 30)}`,
    }));
    if (!sourceOptions.length)
      sourceOptions.push({ value: 0, label: "NO STORED LATENTS" });
    const controls = [];
    controls.push(
      {
        key: "sourceA",
        label: "SOURCE A",
        type: "select",
        options: sourceOptions,
        default: 0,
      },
      {
        key: "sourceB",
        label: "SOURCE B",
        type: "select",
        options: sourceOptions,
        default: Math.min(1, sourceOptions.length - 1),
      },
      {
        key: "mix",
        label: "LATENT INTERPOLATION",
        type: "range",
        min: 0,
        max: 1,
        step: 0.01,
        fineStep: 0.002,
        default: 0.5,
        format: "percent",
        help: "Moves through latent space between the encoded A and B examples rather than blending their pixels.",
      },
      {
        key: "temperature",
        label: "LATENT SCALE",
        type: "range",
        min: 0.4,
        max: 1.8,
        step: 0.01,
        fineStep: 0.002,
        default: 1,
        format: "decimal2",
      },
      {
        key: "latentAxis",
        label: "FREE LATENT AXIS",
        type: "select",
        options: latentOptions(metadata?.latentDim || 64),
        default: 0,
      },
      {
        key: "latentAmount",
        label: "FREE LATENT AMOUNT",
        type: "range",
        min: -3,
        max: 3,
        step: 0.01,
        fineStep: 0.002,
        default: 0,
        format: "decimal2",
      },
      {
        key: "motion",
        label: "INTERPOLATION DRIFT",
        type: "range",
        min: 0,
        max: 1,
        step: 0.01,
        fineStep: 0.002,
        default: 0,
        format: "percent",
        help: "Automatically moves the interpolation position. LFOs can still modulate this or any other numeric control.",
      },
    );
    return controls;
  }

  async ensureModels() {
    if (this.models) return this.models;
    if (!this.modelsPromise) {
      const generation = this.generation;
      const task = (async () => {
        const tf = await ensureTensorFlow();
        if (tf.findBackend("webgl") && tf.getBackend() !== "webgl") {
          try {
            await tf.setBackend("webgl");
            await tf.ready();
          } catch {
            // Keep the runtime-selected backend.
          }
        }
        const loaded = await NeuralModelStore.loadModels();
        if (generation !== this.generation) {
          loaded.encoder?.dispose?.();
          loaded.decoder?.dispose?.();
          throw new Error("Model loading was cancelled.");
        }
        this.models = loaded;
        this.metadata = loaded.metadata;
        return loaded;
      })().finally(() => {
        if (this.modelsPromise === task) this.modelsPromise = null;
      });
      this.modelsPromise = task;
    }
    return this.modelsPromise;
  }

  buildLatent(parameters, timeSeconds = 0) {
    const metadata = this.metadata;
    const dimension = metadata?.latentDim || 64;
    const output = new Float32Array(dimension);
    const temperature = clamp(parameters.temperature, 0.4, 1.8);
    const motion = clamp(parameters.motion, 0, 1);
    const phaseMix = clamp(
      parameters.mix +
        Math.sin(timeSeconds * (0.18 + motion * 0.75)) * motion * 0.35,
      0,
      1,
    );

    const latents = metadata?.sampleLatents || [];
    const a =
      latents[
        Math.round(
          clamp(parameters.sourceA, 0, Math.max(0, latents.length - 1)),
        )
      ] || new Array(dimension).fill(0);
    const b =
      latents[
        Math.round(
          clamp(parameters.sourceB, 0, Math.max(0, latents.length - 1)),
        )
      ] || a;
    for (let index = 0; index < dimension; index += 1) {
      output[index] =
        ((Number(a[index]) || 0) * (1 - phaseMix) +
          (Number(b[index]) || 0) * phaseMix) *
        temperature;
    }

    const axis = Math.round(clamp(parameters.latentAxis, 0, dimension - 1));
    output[axis] += clamp(parameters.latentAmount, -3, 3);
    return output;
  }

  async decodeToCanvas(targetCanvas, latent, parameters = {}) {
    const generation = this.generation;
    const tf = await ensureTensorFlow();
    const { decoder } = await this.ensureModels();
    const input = tf.tensor2d(latent, [1, latent.length]);
    let prediction = null;
    try {
      prediction = decoder.predict(input);
      const values = await prediction.data();
      if (generation !== this.generation) return false;
      const image = new ImageData(MODEL_SIZE, MODEL_SIZE);
      for (let pixel = 0; pixel < MODEL_SIZE * MODEL_SIZE; pixel += 1) {
        const source = pixel * 3;
        const target = pixel * 4;
        image.data[target] = Math.round(clamp(values[source]) * 255);
        image.data[target + 1] = Math.round(clamp(values[source + 1]) * 255);
        image.data[target + 2] = Math.round(clamp(values[source + 2]) * 255);
        image.data[target + 3] = 255;
      }
      const lowContext = this.lowCanvas.getContext("2d", { alpha: false });
      lowContext.putImageData(image, 0, 0);
      applyDatamosh(
        this.lowCanvas,
        this.effectCanvas,
        parameters.datamosh !== false,
      );
      const context = targetCanvas.getContext("2d", { alpha: false });
      context.save();
      context.fillStyle = "#000";
      context.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
      context.imageSmoothingEnabled = false;
      context.drawImage(
        this.lowCanvas,
        0,
        0,
        targetCanvas.width,
        targetCanvas.height,
      );
      context.restore();
      return true;
    } finally {
      prediction?.dispose?.();
      input.dispose();
    }
  }

  async render(canvas, parameters, timeSeconds = 0) {
    const started = performance.now();
    const generation = this.generation;
    try {
      if (!this.metadata)
        throw new Error("Train a model in Experiments first.");
      const latent = this.buildLatent(parameters, timeSeconds);
      const drawn = await this.decodeToCanvas(canvas, latent, parameters);
      return {
        backend: this.backend,
        status: drawn ? "ready" : "cancelled",
        modelMetrics: {
          trainingSamples: this.metadata.trainingSamples,
          latentDimensions: this.metadata.latentDim,
        },
        inferenceMs: performance.now() - started,
      };
    } catch (error) {
      if (generation !== this.generation)
        return { backend: this.backend, status: "cancelled" };
      drawDiagnostic(canvas, "LOCAL MODEL UNAVAILABLE", error.message);
      return {
        backend: this.backend,
        status: "error",
        inferenceMs: performance.now() - started,
      };
    }
  }

  dispose() {
    this.cancel();
    this.disposeModels();
  }
}
