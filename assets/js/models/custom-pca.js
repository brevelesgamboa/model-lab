import { CustomModelStore } from "../core/custom-model-store.js";
import { clamp, gaussian, mulberry32 } from "../core/utils.js";

export class CustomPcaModel {
  constructor() {
    this.data = CustomModelStore.load();
    this.lowCanvas = document.createElement("canvas");
    this.lowCanvas.width = 32;
    this.lowCanvas.height = 32;
    this.lowContext = this.lowCanvas.getContext("2d", { alpha: false });
  }

  reload() {
    this.data = CustomModelStore.load();
  }

  get id() {
    return "custom-pca";
  }
  get name() {
    return this.data?.name || "Quick Local Model";
  }
  get family() {
    return "Locally trained image model";
  }
  get backend() {
    return "CPU / WEB WORKER TRAINING";
  }
  get description() {
    if (!this.data)
      return "No local model is available. Build or import one in Experiments.";
    return `A ${this.data.basis.length}-component ${this.data.colorSpace || "GRAYSCALE"} model trained from ${this.data.trainingSamples} local image samples. Its source images are not embedded in the model file.`;
  }
  get animated() {
    return true;
  }
  get available() {
    return Boolean(this.data);
  }
  get pixelated() {
    return false;
  }
  isDynamic(parameters) {
    return Number(parameters?.motion) > 0.001;
  }

  get controls() {
    const count = this.data?.basis?.length || 2;
    return [
      {
        key: "components",
        label: "ACTIVE COMPONENTS",
        type: "select",
        default: count,
        options: Array.from({ length: count }, (_, index) => ({
          value: index + 1,
          label: `${String(index + 1).padStart(2, "0")} COMPONENT${index ? "S" : ""}`,
        })),
        help: "Limits how many learned variation directions contribute to the output.",
      },
      {
        key: "seed",
        label: "RANDOM SEED",
        type: "number",
        min: 1,
        max: 999999,
        step: 1,
        default: 50117,
      },
      {
        key: "coordinateA",
        label: "LATENT COORDINATE A",
        type: "range",
        min: -3,
        max: 3,
        step: 0.05,
        fineStep: 0.005,
        default: 0,
        format: "decimal2",
      },
      {
        key: "coordinateB",
        label: "LATENT COORDINATE B",
        type: "range",
        min: -3,
        max: 3,
        step: 0.05,
        fineStep: 0.005,
        default: 0,
        format: "decimal2",
      },
      {
        key: "temperature",
        label: "LATENT TEMPERATURE",
        type: "range",
        min: 0.2,
        max: 2.5,
        step: 0.05,
        fineStep: 0.005,
        default: 1,
        format: "decimal2",
      },
      {
        key: "corruption",
        label: "SIGNAL CORRUPTION",
        type: "range",
        min: 0,
        max: 0.65,
        step: 0.01,
        fineStep: 0.001,
        default: 0,
        format: "percent",
      },
      {
        key: "contrast",
        label: "OUTPUT CONTRAST",
        type: "range",
        min: 0.6,
        max: 2,
        step: 0.01,
        fineStep: 0.001,
        default: 1,
        format: "decimal2",
      },
      {
        key: "motion",
        label: "LATENT DRIFT",
        type: "range",
        min: 0,
        max: 1,
        step: 0.01,
        fineStep: 0.001,
        default: 0,
        format: "percent",
      },
      {
        key: "upsampling",
        label: "UPSAMPLING FILTER",
        type: "select",
        default: "smooth",
        options: [
          { value: "smooth", label: "SMOOTH" },
          { value: "nearest", label: "NEAREST" },
        ],
      },
    ];
  }

  render(targetCanvas, parameters, timeSeconds = 0) {
    if (!this.data) throw new Error("No local PCA model has been trained.");
    const started = performance.now();
    const data = this.data;
    const width = data.width;
    const height = data.height;
    const channels = data.channels || 1;
    const pixelCount = width * height;
    const vectorLength = pixelCount * channels;
    const componentCount = Math.round(
      clamp(parameters.components, 1, data.basis.length),
    );
    const seed = Math.round(clamp(parameters.seed, 1, 999999));
    const temperature = clamp(parameters.temperature, 0.2, 2.5);
    const corruption = clamp(parameters.corruption, 0, 0.65);
    const contrast = clamp(parameters.contrast, 0.6, 2);
    const motion = clamp(parameters.motion, 0, 1);
    const phase = timeSeconds * motion * 1.2;
    const random = mulberry32(seed);
    const artifactRandom = mulberry32(
      seed + Math.floor(timeSeconds * 10 * motion) * 65537,
    );

    const latent = new Float32Array(componentCount);
    latent[0] =
      (clamp(parameters.coordinateA, -3, 3) + Math.sin(phase) * motion * 0.75) *
      temperature;
    if (componentCount > 1) {
      latent[1] =
        (clamp(parameters.coordinateB, -3, 3) +
          Math.cos(phase * 0.79) * motion * 0.65) *
        temperature;
    }
    for (let component = 2; component < componentCount; component += 1) {
      latent[component] =
        (gaussian(random) +
          Math.sin(phase * (0.25 + component * 0.08)) * motion * 0.3) *
        temperature;
    }

    const output = new Float32Array(vectorLength);
    output.set(data.mean);
    for (let component = 0; component < componentCount; component += 1) {
      const scale =
        latent[component] *
        Math.sqrt(Math.max(0, data.explainedVariance[component] || 0));
      const basis = data.basis[component];
      for (let value = 0; value < vectorLength; value += 1)
        output[value] += basis[value] * scale;
    }

    for (let value = 0; value < vectorLength; value += 1) {
      output[value] = clamp((output[value] - 0.5) * contrast + 0.5);
      if (artifactRandom() < corruption * 0.018)
        output[value] = artifactRandom() > 0.5 ? 1 : 0;
    }

    if (corruption > 0.04) {
      const source = output.slice();
      for (let y = 0; y < height; y += 1) {
        if (artifactRandom() < corruption * 0.3) {
          const shift = Math.round((artifactRandom() - 0.5) * corruption * 12);
          for (let x = 0; x < width; x += 1) {
            const sourceX = (x - shift + width) % width;
            for (let channel = 0; channel < channels; channel += 1) {
              output[(y * width + x) * channels + channel] =
                source[(y * width + sourceX) * channels + channel];
            }
          }
        }
      }
    }

    if (this.lowCanvas.width !== width || this.lowCanvas.height !== height) {
      this.lowCanvas.width = width;
      this.lowCanvas.height = height;
      this.lowContext = this.lowCanvas.getContext("2d", { alpha: false });
    }

    const image = this.lowContext.createImageData(width, height);
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      const offset = pixel * 4;
      if (channels === 3) {
        image.data[offset] = Math.round(clamp(output[pixel * 3]) * 255);
        image.data[offset + 1] = Math.round(clamp(output[pixel * 3 + 1]) * 255);
        image.data[offset + 2] = Math.round(clamp(output[pixel * 3 + 2]) * 255);
      } else {
        const value = Math.round(clamp(output[pixel]) * 255);
        image.data[offset] = value;
        image.data[offset + 1] = value;
        image.data[offset + 2] = value;
      }
      image.data[offset + 3] = 255;
    }
    this.lowContext.putImageData(image, 0, 0);

    const context = targetCanvas.getContext("2d", { alpha: false });
    context.save();
    context.fillStyle = "#000";
    context.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
    context.imageSmoothingEnabled = parameters.upsampling !== "nearest";
    context.imageSmoothingQuality = "high";
    context.drawImage(
      this.lowCanvas,
      0,
      0,
      targetCanvas.width,
      targetCanvas.height,
    );
    context.restore();

    const retainedVariance = data.explainedVarianceRatio
      .slice(0, componentCount)
      .reduce((sum, value) => sum + value, 0);
    const latentEnergy = Math.sqrt(
      latent.reduce((sum, value) => sum + value * value, 0) / latent.length,
    );
    return {
      backend: this.backend,
      modelMetrics: {
        trainingSamples: data.trainingSamples,
        colorChannels: channels,
        retainedVariance,
        latentEnergy,
        activeComponents: componentCount,
      },
      inferenceMs: performance.now() - started,
    };
  }
}
