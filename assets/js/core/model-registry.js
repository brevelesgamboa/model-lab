import { DigiFaceVaeModel } from "../models/digiface-vae.js";
import { createGpuModels } from "../models/gpu-fields.js";
import { FractalFunctionModel } from "../models/fractal-functions.js";
import { CustomPcaModel } from "../models/custom-pca.js";
import { LocalNeuralModel } from "../models/local-neural.js";
import { InceptionDreamModel } from "../models/inception-dream.js";
import { NeuralGrowthModel } from "../models/neural-growth.js";
import { validateModelDefinition } from "./model-contract.js";

const MODEL_ALIASES = new Map([
  ["ghost-fractal", "folded-fractal"],
  ["solid-fractal", "folded-fractal"],
  ["recursive-geometry", "folded-fractal"],
]);

export class ModelRegistry {
  constructor() {
    this.customModel = new CustomPcaModel();
    this.neuralModel = new LocalNeuralModel();
    this.models = [
      ...createGpuModels(),
      new FractalFunctionModel(),
      new DigiFaceVaeModel(),
      new InceptionDreamModel(),
      new NeuralGrowthModel(),
      this.customModel,
      this.neuralModel,
    ];
    this.models.forEach(validateModelDefinition);
  }

  getAll() {
    return [...this.models];
  }

  get(modelId) {
    const resolvedId = MODEL_ALIASES.get(modelId) || modelId;
    return this.models.find((model) => model.id === resolvedId) || null;
  }

  getDefault() {
    return (
      this.get("folded-fractal") ||
      this.models.find((model) => model.available) ||
      null
    );
  }

  refreshCustom() {
    this.customModel.reload();
    return this.customModel;
  }

  refreshNeural() {
    this.neuralModel.reload();
    return this.neuralModel;
  }

  rendererSummary() {
    const accelerated = this.models.filter((model) =>
      /WEBGL|WEBGPU/.test(model.backend),
    );
    return accelerated.length
      ? `GPU CAPABLE · ${accelerated.length} ROUTES`
      : "CPU / CANVAS FALLBACK";
  }

  dispose() {
    this.models.forEach((model) => model.dispose?.());
  }
}
