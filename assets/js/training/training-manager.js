import { NeuralModelStore } from "../core/neural-model-store.js";
import { activateTensorFlowBackend } from "./tf-runtime.js";
import { benchmarkTrainingHardware } from "./hardware-benchmark.js";
import { NEURAL_INPUT_SIZE, stackSamples } from "./dataset-preprocessor.js";
import { getTrainingProfile } from "./profiles/index.js";
import { buildAutoencoder } from "./objectives/autoencoder.js";

const QUALITY_SETTINGS = {
  high: { batchSize: 4 },
};

function disposeTensor(value) {
  if (!value) return;
  if (Array.isArray(value)) value.forEach(disposeTensor);
  else if (typeof value.dispose === "function") value.dispose();
}

function cloneWeights(model) {
  return model.getWeights().map((weight) => weight.clone());
}

function disposeWeights(weights) {
  weights?.forEach((weight) => weight.dispose());
}

async function encodeSamples(encoder, objective, images) {
  const output = encoder.predict(images);
  let latent = output;
  try {
    if (objective === "generate" && Array.isArray(output)) latent = output[0];
    const values = await latent.array();
    return values.map((row) => Array.from(row, Number));
  } finally {
    if (Array.isArray(output)) disposeTensor(output);
    else output?.dispose?.();
  }
}

export class TrainingManager {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.benchmarkResult = null;
    this.activeModel = null;
    this.stopRequested = false;
    this.training = false;
  }

  async benchmark({ force = false } = {}) {
    if (this.benchmarkResult && !force) return this.benchmarkResult;
    this.benchmarkResult = await benchmarkTrainingHardware({
      onStatus: (message) => this.callbacks.onStatus?.(message),
    });
    this.callbacks.onBenchmark?.(this.benchmarkResult);
    return this.benchmarkResult;
  }

  stop() {
    this.stopRequested = true;
    if (this.activeModel) this.activeModel.stopTraining = true;
  }

  async train({ samples, name }) {
    if (this.training)
      throw new Error("A neural training session is already running.");
    const profile = getTrainingProfile("datamosh");
    const objective = "reconstruct";
    const quality = "high";
    const latentDim = 64;
    const timeBudgetSeconds = 300;
    const safeSamples = Array.isArray(samples)
      ? samples.slice(0, profile.maxSamples)
      : [];
    if (safeSamples.length < profile.minSamples) {
      throw new Error(
        `${profile.name} neural training needs at least ${profile.minSamples} images.`,
      );
    }

    this.training = true;
    this.stopRequested = false;
    let tf;
    let images = null;
    let targets = null;
    let bundle = null;
    let bestWeights = null;
    let bestLoss = Number.POSITIVE_INFINITY;
    let finalLoss = Number.NaN;
    let epochCount = 0;
    let epochsSinceBest = 0;
    const lossHistory = [];
    const startedAt = performance.now();

    try {
      tf = await activateTensorFlowBackend(["webgl"]);
      const benchmark = await this.benchmark();
      if (benchmark.backend !== "webgl" || benchmark.speedClass !== "FAST") {
        throw new Error(
          "High-end neural training requires a FAST WebGL benchmark. Use Quick PCA on this device.",
        );
      }

      images = stackSamples(tf, safeSamples, NEURAL_INPUT_SIZE);
      bundle = buildAutoencoder(tf, {
        inputSize: NEURAL_INPUT_SIZE,
        latentDim,
        quality,
      });

      this.activeModel = bundle.trainingModel;
      targets = bundle.makeTargets(images);
      const batchSize = Math.min(
        QUALITY_SETTINGS[quality].batchSize,
        safeSamples.length,
      );
      this.callbacks.onStatus?.(
        `TRAINING ${profile.name} / ${objective.toUpperCase()} / ${benchmark.backend.toUpperCase()}`,
      );
      this.callbacks.onStart?.({
        profile,
        objective,
        quality,
        latentDim,
        batchSize,
        timeBudgetSeconds,
        backend: benchmark.backend,
      });

      await bundle.trainingModel.fit(images, targets, {
        epochs: 10000,
        batchSize,
        shuffle: true,
        callbacks: {
          onEpochEnd: async (epoch, logs = {}) => {
            epochCount = epoch + 1;
            const elapsedSeconds = (performance.now() - startedAt) / 1000;
            const loss = Number(logs.loss);
            finalLoss = loss;

            if (Number.isFinite(loss)) {
              lossHistory.push({ epoch: epochCount, loss, elapsedSeconds });
              if (loss < bestLoss * 0.998 || !Number.isFinite(bestLoss)) {
                bestLoss = loss;
                epochsSinceBest = 0;
                disposeWeights(bestWeights);
                bestWeights = cloneWeights(bundle.trainingModel);
              } else {
                epochsSinceBest += 1;
              }
            }

            const progress = Math.min(
              99,
              (elapsedSeconds / timeBudgetSeconds) * 100,
            );
            this.callbacks.onProgress?.({
              progress,
              epoch: epochCount,
              loss,
              bestLoss,
              elapsedSeconds,
              timeBudgetSeconds,
              backend: benchmark.backend,
              lossHistory: lossHistory.slice(),
            });

            const plateau =
              epochCount >= 30 &&
              epochsSinceBest >= 25 &&
              elapsedSeconds >= Math.min(120, timeBudgetSeconds * 0.5);
            if (
              this.stopRequested ||
              elapsedSeconds >= timeBudgetSeconds ||
              plateau
            ) {
              bundle.trainingModel.stopTraining = true;
            }
            await tf.nextFrame();
          },
        },
      });

      if (bestWeights?.length) {
        bundle.trainingModel.setWeights(bestWeights);
      }

      this.callbacks.onStatus?.(
        "ENCODING TRAINING IMAGES INTO THE LATENT SPACE",
      );
      const sampleLatents = await encodeSamples(
        bundle.encoder,
        objective,
        images,
      );

      const trainingSeconds = (performance.now() - startedAt) / 1000;
      const metadata = {
        schema: "latent-field-local-neural-v1",
        version: "1.0.0",
        name,
        profile: profile.id,
        objective,
        inputSize: NEURAL_INPUT_SIZE,
        latentDim,
        quality,
        backend: benchmark.backend,
        trainingSamples: safeSamples.length,
        sampleNames: safeSamples.map((sample, index) =>
          String(sample.name || `SAMPLE_${index + 1}`).slice(0, 80),
        ),
        sampleLatents,
        finalLoss: Number.isFinite(finalLoss) ? finalLoss : bestLoss,
        bestLoss: Number.isFinite(bestLoss) ? bestLoss : finalLoss,
        epochs: epochCount,
        trainingSeconds,
        timeBudgetSeconds,
        framework: "TensorFlow.js 4.22.0",
        lossHistory: lossHistory.slice(-180),
        createdAt: new Date().toISOString(),
      };

      this.callbacks.onStatus?.("SAVING ENCODER + DECODER TO INDEXEDDB");
      const saved = await NeuralModelStore.save({
        encoder: bundle.encoder,
        decoder: bundle.decoder,
        metadata,
      });

      this.callbacks.onProgress?.({
        progress: 100,
        epoch: epochCount,
        loss: saved.finalLoss,
        bestLoss: saved.bestLoss,
        elapsedSeconds: trainingSeconds,
        timeBudgetSeconds,
        backend: benchmark.backend,
        lossHistory: lossHistory.slice(),
      });
      this.callbacks.onComplete?.(saved);
      return saved;
    } catch (error) {
      this.callbacks.onError?.(error);
      throw error;
    } finally {
      disposeWeights(bestWeights);
      if (targets && targets !== images) {
        if (Array.isArray(targets)) {
          targets.forEach((target) => {
            if (target !== images) target.dispose?.();
          });
        } else {
          targets.dispose?.();
        }
      }
      images?.dispose?.();
      this.activeModel = null;
      this.training = false;
      this.stopRequested = false;
    }
  }
}
