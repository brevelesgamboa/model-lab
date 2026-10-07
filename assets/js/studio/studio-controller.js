import {
  CustomModelStore,
  validateCustomModel,
} from "../core/custom-model-store.js";
import { NeuralModelStore } from "../core/neural-model-store.js";
import { licenseGroup, searchCommons } from "../core/commons-search.js";
import {
  clamp,
  downloadBlob,
  formatPercent,
  sanitizeModelName,
} from "../core/utils.js";
import {
  NEURAL_INPUT_SIZE,
  PCA_INPUT_SIZE,
  resampleRgbPixels,
} from "../training/dataset-preprocessor.js";
import { getTrainingProfile } from "../training/profiles/index.js";
import { TrainingManager } from "../training/training-manager.js";
import { terminal } from "../ui/terminal.js";

const STUDIO_SAMPLE_SIZE = NEURAL_INPUT_SIZE;
const PCA_TRAINING_SIZE = PCA_INPUT_SIZE;
const MAX_STUDIO_SAMPLES = 64;

export function createStudioController({
  elements,
  registry,
  getCurrentModel,
  defaultParameters,
  refreshModelOptions,
  selectModel,
  navigate,
  updateResourceStatus,
  setStatus,
  formatArchiveTime,
  withExclusiveCompute,
}) {
  let studioSamples = [];
  let trainingWorker = null;
  let neuralTrainingActive = false;
  let neuralTrainingApproved = false;
  let trainingLossHistory = [];
  let drawing = false;
  let previousDrawPoint = null;
  let commonsAbortController = null;
  let datasetPreparing = false;
  const eventController = new AbortController();

  const trainingManager = new TrainingManager({
    onStatus(message) {
      elements.trainingStatus.textContent = String(message || "").toUpperCase();
    },
    onBenchmark(result) {
      elements.trainingBackend.textContent = result.accelerated
        ? result.backend.toUpperCase() + " / GPU"
        : result.backend.toUpperCase() + " / CPU";
      elements.trainingSpeed.textContent =
        result.speedClass +
        " / " +
        result.millisecondsPerPass.toFixed(1) +
        " MS";
      elements.trainingRecommended.textContent =
        result.recommendedQuality.toUpperCase();
    },
    onProgress(progress) {
      trainingLossHistory = progress.lossHistory || trainingLossHistory;
      elements.trainingProgress.value = progress.progress;
      const lossText = Number.isFinite(progress.loss)
        ? progress.loss.toFixed(5)
        : "—";
      elements.trainingStatus.textContent =
        "EPOCH " +
        progress.epoch +
        " · LOSS " +
        lossText +
        " · " +
        progress.elapsedSeconds.toFixed(1) +
        " / " +
        progress.timeBudgetSeconds +
        "s · " +
        progress.backend.toUpperCase();
      drawTrainingLossChart(trainingLossHistory);
    },
  });

  function clearDrawingPad() {
    const context = elements.drawCanvas.getContext("2d", { alpha: false });
    context.fillStyle = "#000";
    context.fillRect(
      0,
      0,
      elements.drawCanvas.width,
      elements.drawCanvas.height,
    );
  }

  function drawPosition(event) {
    const bounds = elements.drawCanvas.getBoundingClientRect();
    return {
      x:
        ((event.clientX - bounds.left) * elements.drawCanvas.width) /
        bounds.width,
      y:
        ((event.clientY - bounds.top) * elements.drawCanvas.height) /
        bounds.height,
    };
  }

  function drawStroke(event) {
    if (!drawing) return;
    const point = drawPosition(event);
    const context = elements.drawCanvas.getContext("2d", { alpha: false });
    context.strokeStyle = elements.drawColor.value;
    context.lineWidth = Number(elements.brushSize.value);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(
      previousDrawPoint?.x ?? point.x,
      previousDrawPoint?.y ?? point.y,
    );
    context.lineTo(point.x, point.y);
    context.stroke();
    previousDrawPoint = point;
  }

  function canvasToRgbSample(sourceCanvas) {
    const work = document.createElement("canvas");
    work.width = STUDIO_SAMPLE_SIZE;
    work.height = STUDIO_SAMPLE_SIZE;
    const workContext = work.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    });
    workContext.fillStyle = "#000";
    workContext.fillRect(0, 0, STUDIO_SAMPLE_SIZE, STUDIO_SAMPLE_SIZE);
    workContext.imageSmoothingEnabled = true;
    workContext.imageSmoothingQuality = "high";
    const crop = Math.min(sourceCanvas.width, sourceCanvas.height);
    const sourceX = (sourceCanvas.width - crop) * 0.5;
    const sourceY = (sourceCanvas.height - crop) * 0.5;
    workContext.drawImage(
      sourceCanvas,
      sourceX,
      sourceY,
      crop,
      crop,
      0,
      0,
      STUDIO_SAMPLE_SIZE,
      STUDIO_SAMPLE_SIZE,
    );
    const { data } = workContext.getImageData(
      0,
      0,
      STUDIO_SAMPLE_SIZE,
      STUDIO_SAMPLE_SIZE,
    );
    const pixels = new Float32Array(
      STUDIO_SAMPLE_SIZE * STUDIO_SAMPLE_SIZE * 3,
    );
    for (
      let pixel = 0;
      pixel < STUDIO_SAMPLE_SIZE * STUDIO_SAMPLE_SIZE;
      pixel += 1
    ) {
      const source = pixel * 4;
      const target = pixel * 3;
      pixels[target] = data[source] / 255;
      pixels[target + 1] = data[source + 1] / 255;
      pixels[target + 2] = data[source + 2] / 255;
    }
    return pixels;
  }

  function drawTrainingLossChart(history = []) {
    const chart = elements.trainingLossChart;
    if (!chart) return;
    const context = chart.getContext("2d", { alpha: false });
    context.fillStyle = "#050506";
    context.fillRect(0, 0, chart.width, chart.height);
    context.strokeStyle = "#2b2730";
    context.lineWidth = 1;
    for (let line = 1; line < 4; line += 1) {
      const y = 14 + line * ((chart.height - 34) / 4);
      context.beginPath();
      context.moveTo(18, y);
      context.lineTo(chart.width - 10, y);
      context.stroke();
    }

    const values = history
      .map((item) => Number(item.loss))
      .filter((value) => Number.isFinite(value));
    if (values.length < 2) {
      context.fillStyle = "#625c66";
      context.font = "11px monospace";
      context.textAlign = "center";
      context.fillText(
        values.length
          ? `LOSS ${values[0].toFixed(5)}`
          : "NO NEURAL TRAINING HISTORY",
        chart.width / 2,
        chart.height / 2,
      );
      return;
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(1e-6, max - min);
    const left = 20;
    const right = chart.width - 12;
    const top = 15;
    const bottom = chart.height - 22;
    context.strokeStyle = "#b8adff";
    context.lineWidth = 2;
    context.beginPath();
    values.forEach((value, index) => {
      const x =
        left + (index / Math.max(1, values.length - 1)) * (right - left);
      const y = bottom - ((value - min) / span) * (bottom - top);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
    context.fillStyle = "#8c8691";
    context.font = "9px monospace";
    context.textAlign = "left";
    context.fillText(`START ${values[0].toFixed(4)}`, left, chart.height - 7);
    context.textAlign = "right";
    context.fillText(
      `BEST ${Math.min(...values).toFixed(4)}`,
      right,
      chart.height - 7,
    );
  }

  function currentTrainingEngine() {
    return elements.trainingEngine?.value === "pca" ? "pca" : "neural";
  }

  function currentNeuralProfile() {
    return getTrainingProfile("datamosh");
  }

  function minimumStudioSamples() {
    return currentTrainingEngine() === "pca"
      ? 3
      : currentNeuralProfile().minSamples;
  }

  function trainingBusy() {
    return Boolean(trainingWorker) || neuralTrainingActive;
  }

  function updateTrainButtonState() {
    const minimum = minimumStudioSamples();
    const neuralLocked =
      currentTrainingEngine() === "neural" && !neuralTrainingApproved;
    const busy = trainingBusy() || datasetPreparing;
    elements.trainModel.disabled =
      studioSamples.length < minimum || busy || neuralLocked;
    elements.trainModel.title = neuralLocked
      ? "Run the neural training access check first."
      : "";
    elements.clearDataset.disabled = busy;
    elements.imageUpload.disabled = busy;
    elements.addDrawing.disabled = busy;
    elements.addSyntheticSet.disabled = busy;
    elements.trainingEngine.disabled = busy;
  }

  async function withDatasetPreparation(operation) {
    if (datasetPreparing || trainingBusy()) {
      setStatus("WAIT FOR THE CURRENT DATASET OPERATION");
      return false;
    }
    datasetPreparing = true;
    updateTrainButtonState();
    try {
      return await operation();
    } finally {
      datasetPreparing = false;
      updateTrainButtonState();
    }
  }

  function updateTrainingEngineUi({ announce = false } = {}) {
    const neural = currentTrainingEngine() === "neural";
    elements.neuralTrainingControls.hidden = !neural;
    elements.pcaTrainingControls.hidden = neural;
    elements.pcaModelFileActions.hidden = neural;
    elements.neuralAnalysisBlock.hidden = !neural;
    elements.pcaAnalysisBlock.hidden = neural;
    elements.trainModel.textContent = neural
      ? "TRAIN NEURAL MODEL"
      : "TRAIN QUICK PCA MODEL";

    const strong = elements.trainingNote?.querySelector("strong");
    const paragraph = elements.trainingNote?.querySelector("p");
    if (neural) {
      if (strong) strong.textContent = "EXPERIMENTAL NEURAL TRAINING";
      if (paragraph)
        paragraph.textContent =
          "This demo enables neural training only after an acceptable WebGL benchmark. CPU and limited WebGL devices can use Quick PCA and every curated inference model.";
      const profile = currentNeuralProfile();
      if (!trainingBusy()) {
        if (!neuralTrainingApproved) {
          elements.trainingStatus.textContent =
            "NEURAL TRAINING LOCKED. RUN THE GPU ACCESS CHECK, OR USE QUICK PCA.";
        } else {
          elements.trainingStatus.textContent =
            studioSamples.length >= profile.minSamples
              ? `${studioSamples.length} IMAGES READY FOR ${profile.name} NEURAL TRAINING.`
              : `${profile.name} NEURAL TRAINING NEEDS AT LEAST ${profile.minSamples} IMAGES.`;
        }
      }
    } else {
      if (strong) strong.textContent = "QUICK PCA PATH";
      if (paragraph)
        paragraph.textContent =
          "Quick PCA downsamples the 128px studio samples to 48 × 48 RGB and builds a fast linear baseline. The datamosh autoencoder is reserved for FAST WebGL hardware.";
      if (!trainingBusy())
        elements.trainingStatus.textContent =
          studioSamples.length >= 3
            ? `${studioSamples.length} IMAGES READY FOR QUICK PCA.`
            : "PCA NEEDS AT LEAST 3 IMAGES.";
    }
    updateTrainButtonState();
    if (announce)
      terminal(
        "EXPERIMENTS",
        neural
          ? "neural TensorFlow.js training selected"
          : "quick PCA training selected",
      );
  }

  function setNeuralTrainingBusy(active) {
    neuralTrainingActive = Boolean(active);
    elements.stopTraining.hidden = !active;
    elements.trainingEngine.disabled = active;
    elements.benchmarkTraining.disabled = active;
    updateTrainButtonState();
  }

  async function benchmarkNeuralHardware({ force = true } = {}) {
    if (neuralTrainingActive) return null;
    if (force) neuralTrainingApproved = false;
    updateTrainButtonState();
    elements.benchmarkTraining.disabled = true;
    elements.trainingStatus.textContent =
      "LOADING TENSORFLOW.JS AND BENCHMARKING THE TRAINING BACKEND.";
    try {
      const result = await withExclusiveCompute(() =>
        trainingManager.benchmark({ force }),
      );
      neuralTrainingApproved = Boolean(
        result.accelerated &&
        result.backend === "webgl" &&
        result.speedClass === "FAST",
      );
      elements.trainingRecommended.textContent = neuralTrainingApproved
        ? `${result.recommendedQuality.toUpperCase()} / ALLOWED`
        : "PCA + LAB";
      elements.trainingStatus.textContent = neuralTrainingApproved
        ? "NEURAL TRAINING ACCESS ENABLED FOR THIS SESSION."
        : "NEURAL TRAINING DISABLED: THIS DEMO REQUIRES AN ACCEPTABLE WEBGL GPU RESULT. USE QUICK PCA OR A LAB MODEL.";
      terminal(
        "NEURAL BENCHMARK",
        `${result.backend.toUpperCase()} / ${result.speedClass} / ${result.millisecondsPerPass.toFixed(1)} ms reference convolution`,
      );
      terminal(
        "NEURAL ACCESS",
        neuralTrainingApproved
          ? "enabled for this session"
          : "denied; Quick PCA and Lab models remain available",
        neuralTrainingApproved ? "info" : "warning",
      );
      setStatus(
        neuralTrainingApproved
          ? "NEURAL TRAINING ENABLED"
          : "USE PCA OR LAB MODELS",
      );
      updateTrainButtonState();
      return result;
    } catch (error) {
      neuralTrainingApproved = false;
      const message = error instanceof Error ? error.message : String(error);
      elements.trainingBackend.textContent = "UNAVAILABLE";
      elements.trainingSpeed.textContent = "ERROR";
      elements.trainingRecommended.textContent = "USE PCA";
      elements.trainingStatus.textContent = `BENCHMARK ERROR: ${message}`;
      terminal("NEURAL BENCHMARK", message, "warning");
      return null;
    } finally {
      updateTrainButtonState();
      elements.benchmarkTraining.disabled = false;
    }
  }

  function updateNeuralModelPanel() {
    const metadata = NeuralModelStore.loadMetadata();
    const available = Boolean(metadata);
    elements.neuralStatus.textContent = available ? "READY" : "NOT TRAINED";
    elements.neuralId.textContent = available ? metadata.name : "-";
    elements.neuralProfileStat.textContent = available
      ? metadata.profile.toUpperCase()
      : "-";
    elements.neuralObjectiveStat.textContent = available
      ? metadata.objective.toUpperCase()
      : "-";
    elements.neuralSamples.textContent = available
      ? String(metadata.trainingSamples)
      : "-";
    elements.neuralLatent.textContent = available
      ? String(metadata.latentDim)
      : "-";
    elements.neuralBackendStat.textContent = available
      ? String(metadata.backend).toUpperCase()
      : "-";
    elements.neuralLoss.textContent =
      available && Number.isFinite(metadata.bestLoss)
        ? metadata.bestLoss.toFixed(5)
        : "-";
    elements.neuralCreated.textContent = available
      ? formatArchiveTime(metadata.createdAt)
      : "-";
    elements.deleteNeuralModel.disabled = !available || neuralTrainingActive;
    elements.launchNeural.disabled = !available;
    trainingLossHistory = available ? metadata.lossHistory || [] : [];
    drawTrainingLossChart(trainingLossHistory);
  }

  async function trainNeuralModel() {
    if (neuralTrainingActive || trainingWorker) return;
    if (!neuralTrainingApproved) {
      elements.trainingStatus.textContent =
        "NEURAL TRAINING LOCKED. PASS THE GPU ACCESS CHECK FIRST.";
      setStatus("NEURAL TRAINING LOCKED");
      return;
    }
    const profile = currentNeuralProfile();
    if (studioSamples.length < profile.minSamples) {
      elements.trainingStatus.textContent = `${profile.name} NEURAL TRAINING NEEDS AT LEAST ${profile.minSamples} IMAGES.`;
      return;
    }

    const name = sanitizeModelName(
      elements.customModelName.value || "LOCAL_NEURAL_01",
    );
    elements.customModelName.value = name;
    trainingLossHistory = [];
    drawTrainingLossChart(trainingLossHistory);
    elements.trainingProgress.value = 1;
    setNeuralTrainingBusy(true);
    elements.trainingStatus.textContent = "INITIALIZING NEURAL TRAINING.";

    try {
      const metadata = await withExclusiveCompute(() =>
        trainingManager.train({ samples: studioSamples, name }),
      );
      registry.refreshNeural();
      refreshModelOptions(getCurrentModel().id);
      updateNeuralModelPanel();
      elements.trainingProgress.value = 100;
      elements.trainingStatus.textContent = `${metadata.name} READY · ${metadata.profile.toUpperCase()} ${metadata.objective.toUpperCase()} · LOSS ${Number(metadata.bestLoss).toFixed(5)}.`;
      terminal(
        "NEURAL MODEL",
        `${metadata.name} / ${metadata.trainingSamples} images / ${metadata.latentDim} latent / ${metadata.backend.toUpperCase()} / ${metadata.trainingSeconds.toFixed(1)}s`,
      );
      setStatus("LOCAL NEURAL MODEL READY");
      updateResourceStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      elements.trainingStatus.textContent = `NEURAL TRAINING ERROR: ${message}`;
      terminal("NEURAL TRAINING", message, "warning");
      setStatus("NEURAL TRAINING ERROR");
    } finally {
      setNeuralTrainingBusy(false);
    }
  }

  async function deleteNeuralModel() {
    const metadata = NeuralModelStore.loadMetadata();
    if (!metadata || neuralTrainingActive) return;
    if (!window.confirm(`Delete local neural model ${metadata.name}?`)) return;
    try {
      await withExclusiveCompute(() => NeuralModelStore.clear());
      registry.refreshNeural();
      if (getCurrentModel().id === "local-neural")
        selectModel("digiface-vae", { log: false });
      refreshModelOptions(getCurrentModel().id);
      updateNeuralModelPanel();
      elements.trainingStatus.textContent = "LOCAL NEURAL MODEL DELETED.";
      terminal(
        "NEURAL MODEL",
        "encoder + decoder deleted from IndexedDB",
        "warning",
      );
      setStatus("LOCAL NEURAL MODEL DELETED");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      elements.trainingStatus.textContent = `DELETE ERROR: ${message}`;
      terminal("NEURAL MODEL", message, "warning");
    }
  }

  function launchNeuralModel() {
    registry.refreshNeural();
    const model = registry.get("local-neural");
    if (!model.available) return;
    refreshModelOptions("local-neural");
    navigate("lab");
    selectModel("local-neural");
  }

  function sampleDeviation(pixels) {
    let mean = 0;
    for (const value of pixels) mean += value;
    mean /= pixels.length;
    let variance = 0;
    for (const value of pixels) variance += (value - mean) ** 2;
    return Math.sqrt(variance / pixels.length);
  }

  function addStudioSample(pixels, name, source = {}) {
    if (studioSamples.length >= MAX_STUDIO_SAMPLES)
      throw new Error(
        `The studio accepts at most ${MAX_STUDIO_SAMPLES} samples.`,
      );
    const values =
      pixels instanceof Float32Array ? pixels : Float32Array.from(pixels);
    if (values.length !== STUDIO_SAMPLE_SIZE * STUDIO_SAMPLE_SIZE * 3)
      throw new Error("The image sample has the wrong dimensions.");
    if (sampleDeviation(values) < 0.012)
      throw new Error("The image contains too little visual variation.");
    studioSamples.push({
      pixels: values,
      name: String(name || `SAMPLE_${studioSamples.length + 1}`).slice(0, 80),
      source: {
        title: String(source.title || name || "LOCAL FILE").slice(0, 120),
        creator: String(source.creator || "LOCAL USER").slice(0, 160),
        license: String(source.license || "LOCAL INPUT").slice(0, 80),
        sourceUrl: String(source.sourceUrl || "").slice(0, 500),
      },
    });
    renderSampleGrid();
  }

  function addDrawingSample() {
    try {
      addStudioSample(
        canvasToRgbSample(elements.drawCanvas),
        `DRAWING_${String(studioSamples.length + 1).padStart(2, "0")}`,
        {
          creator: "LOCAL DRAWING",
          license: "USER PROVIDED",
        },
      );
      elements.trainingStatus.textContent =
        "DRAWING ADDED TO THE LOCAL DATASET.";
      setStatus("DRAWING ADDED");
    } catch (error) {
      elements.trainingStatus.textContent =
        error instanceof Error ? error.message.toUpperCase() : String(error);
    }
  }

  async function fileToSample(file, source = {}) {
    if (!file || !String(file.type || "").startsWith("image/"))
      throw new Error("Only image files are accepted.");
    if (file.size > 12 * 1024 * 1024)
      throw new Error(`${file.name} is larger than 12 MB.`);
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      const url = URL.createObjectURL(file);
      try {
        const image = await new Promise((resolve, reject) => {
          const element = new Image();
          element.onload = () => resolve(element);
          element.onerror = () =>
            reject(new Error(`Could not decode ${file.name}.`));
          element.src = url;
        });
        bitmap = image;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = bitmap.width;
    sourceCanvas.height = bitmap.height;
    const sourceContext = sourceCanvas.getContext("2d", { alpha: false });
    sourceContext.drawImage(bitmap, 0, 0);
    if (typeof bitmap.close === "function") bitmap.close();
    return {
      pixels: canvasToRgbSample(sourceCanvas),
      name: file.name,
      source,
    };
  }

  async function addUploadedFiles(files, sourceOverride = null) {
    return withDatasetPreparation(() =>
      prepareUploadedFiles(files, sourceOverride),
    );
  }

  async function prepareUploadedFiles(files, sourceOverride) {
    const selected = Array.from(files || []).slice(
      0,
      MAX_STUDIO_SAMPLES - studioSamples.length,
    );
    if (!selected.length) return;
    elements.trainingStatus.textContent = `READING ${selected.length} IMAGE FILES.`;
    let added = 0;
    for (const file of selected) {
      try {
        const sample = await fileToSample(
          file,
          sourceOverride || {
            title: file.name,
            creator: "LOCAL USER",
            license: "USER PROVIDED",
          },
        );
        addStudioSample(sample.pixels, sample.name, sample.source);
        added += 1;
      } catch (error) {
        terminal(
          "IMAGE SKIPPED",
          error instanceof Error ? error.message : String(error),
          "warning",
        );
      }
    }
    elements.imageUpload.value = "";
    elements.trainingStatus.textContent = `${added} IMAGE${added === 1 ? "" : "S"} ADDED. ${studioSamples.length} TOTAL.`;
    setStatus(`${added} IMAGES ADDED`);
  }

  async function addDigiFaceModelSet() {
    return withDatasetPreparation(generateDigiFaceModelSet);
  }

  async function generateDigiFaceModelSet() {
    const remaining = MAX_STUDIO_SAMPLES - studioSamples.length;
    const count = Math.min(32, remaining);
    if (count <= 0) {
      elements.trainingStatus.textContent = `THE LOCAL DATASET ALREADY CONTAINS ${MAX_STUDIO_SAMPLES} SAMPLES.`;
      return;
    }

    const model = registry.get("digiface-vae");
    if (!model?.available) {
      elements.trainingStatus.textContent =
        "DIGIFACE VAE ROUTE IS NOT AVAILABLE.";
      return;
    }

    const portraitCanvas = document.createElement("canvas");
    portraitCanvas.width = 320;
    portraitCanvas.height = 320;
    const initialSampleCount = studioSamples.length;
    const base = defaultParameters(model);
    elements.addSyntheticSet.disabled = true;
    elements.trainingStatus.textContent = `GENERATING ${count} DIGIFACE MODEL SAMPLES LOCALLY.`;

    try {
      for (let index = 0; index < count; index += 1) {
        const sequence = initialSampleCount + index;
        const parameters = {
          ...base,
          seed: 17011 + sequence * 7919,
          temperature: 0.85 + (sequence % 5) * 0.07,
          eyeAmount: 0,
          noseAmount: 0,
          mouthAmount: 0,
          expressionAmount: 0,
          ageAmount: 0,
          freeAmount: 0,
          skinStrength: 0,
        };
        const result = await withExclusiveCompute(() =>
          model.render(portraitCanvas, parameters, 0),
        );
        if (result.modelMetrics?.modelState === "ERROR")
          throw new Error("DigiFace inference failed.");
        addStudioSample(
          canvasToRgbSample(portraitCanvas),
          `DIGIFACE_VAE_${String(sequence + 1).padStart(2, "0")}`,
          {
            title: `Latent Field DigiFace output ${sequence + 1}`,
            creator: "Latent Field / DigiFace Generator",
            license: "MODEL OUTPUT / REVIEW DIGIFACE RESEARCH TERMS",
            sourceUrl: "local://digiface-latent-vae-01",
          },
        );
        elements.trainingStatus.textContent = `GENERATED ${index + 1} / ${count} LOCAL MODEL SAMPLES.`;
      }
      terminal("DATASET", `${count} DigiFace VAE outputs added to Experiments`);
      setStatus(`${count} DIGIFACE OUTPUTS ADDED`);
    } catch (error) {
      elements.trainingStatus.textContent = `DIGIFACE GENERATION FAILED: ${error instanceof Error ? error.message : String(error)}`;
      terminal(
        "DIGIFACE",
        error instanceof Error ? error.message : String(error),
        "warning",
      );
    } finally {
      elements.addSyntheticSet.disabled = false;
    }
  }

  function renderSampleTile(sample, index) {
    const tile = document.createElement("div");
    tile.className = "sample-tile";
    tile.title = `${sample.name} / ${sample.source.license}`;
    const canvas = document.createElement("canvas");
    canvas.width = STUDIO_SAMPLE_SIZE;
    canvas.height = STUDIO_SAMPLE_SIZE;
    const context = canvas.getContext("2d", { alpha: false });
    const image = context.createImageData(
      STUDIO_SAMPLE_SIZE,
      STUDIO_SAMPLE_SIZE,
    );
    for (
      let pixel = 0;
      pixel < STUDIO_SAMPLE_SIZE * STUDIO_SAMPLE_SIZE;
      pixel += 1
    ) {
      const source = pixel * 3;
      const target = pixel * 4;
      image.data[target] = Math.round(clamp(sample.pixels[source]) * 255);
      image.data[target + 1] = Math.round(
        clamp(sample.pixels[source + 1]) * 255,
      );
      image.data[target + 2] = Math.round(
        clamp(sample.pixels[source + 2]) * 255,
      );
      image.data[target + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "X";
    remove.setAttribute("aria-label", `Remove ${sample.name}`);
    remove.addEventListener("click", () => {
      studioSamples.splice(index, 1);
      renderSampleGrid();
    });
    tile.append(canvas, remove);
    return tile;
  }

  function renderSampleGrid() {
    elements.sampleGrid.replaceChildren();
    elements.sampleCount.textContent = `${studioSamples.length} / ${MAX_STUDIO_SAMPLES}`;
    updateTrainButtonState();
    if (!studioSamples.length) {
      const empty = document.createElement("div");
      empty.className = "sample-empty";
      empty.textContent = "NO LOCAL SAMPLES";
      elements.sampleGrid.append(empty);
      return;
    }
    studioSamples.forEach((sample, index) =>
      elements.sampleGrid.append(renderSampleTile(sample, index)),
    );
  }

  function drawVarianceChart(model) {
    const chart = elements.varianceChart;
    const context = chart.getContext("2d", { alpha: false });
    context.fillStyle = "#050506";
    context.fillRect(0, 0, chart.width, chart.height);
    context.strokeStyle = "#312d36";
    context.lineWidth = 1;
    for (let line = 1; line < 4; line += 1) {
      const y = 15 + line * ((chart.height - 35) / 4);
      context.beginPath();
      context.moveTo(20, y);
      context.lineTo(chart.width - 12, y);
      context.stroke();
    }
    if (!model?.explainedVarianceRatio?.length) {
      context.fillStyle = "#625c66";
      context.font = "11px monospace";
      context.textAlign = "center";
      context.fillText("NO MODEL", chart.width / 2, chart.height / 2);
      return;
    }
    const values = model.explainedVarianceRatio;
    const gap = 7;
    const usable = chart.width - 38;
    const barWidth = Math.max(
      8,
      (usable - gap * (values.length - 1)) / values.length,
    );
    values.forEach((value, index) => {
      const x = 22 + index * (barWidth + gap);
      const height = clamp(value) * (chart.height - 42);
      const y = chart.height - 22 - height;
      const gradient = context.createLinearGradient(0, y, 0, chart.height - 22);
      gradient.addColorStop(0, "#c2b7ff");
      gradient.addColorStop(1, "#7254f4");
      context.fillStyle = gradient;
      context.fillRect(x, y, barWidth, height);
      context.fillStyle = "#8c8691";
      context.font = "9px monospace";
      context.textAlign = "center";
      context.fillText(String(index + 1), x + barWidth / 2, chart.height - 7);
    });
  }

  function updateCustomModelPanel() {
    const model = CustomModelStore.load();
    const available = Boolean(model);
    elements.customStatus.textContent = available ? "READY" : "NOT TRAINED";
    elements.customId.textContent = available ? model.name : "-";
    elements.customSamples.textContent = available
      ? String(model.trainingSamples)
      : "-";
    elements.customComponents.textContent = available
      ? String(model.basis.length)
      : "-";
    elements.customVariance.textContent = available
      ? formatPercent(model.totalVarianceRetained, 1)
      : "-";
    elements.customCreated.textContent = available
      ? formatArchiveTime(model.createdAt)
      : "-";
    elements.exportModel.disabled = !available;
    elements.deleteModel.disabled = !available;
    elements.launchCustom.disabled = !available;
    drawVarianceChart(model);
  }

  function trainPcaModel() {
    if (studioSamples.length < 3 || trainingWorker || neuralTrainingActive)
      return;
    const name = sanitizeModelName(elements.customModelName.value);
    elements.customModelName.value = name;
    elements.trainingProgress.value = 2;
    elements.trainingStatus.textContent = "STARTING LOCAL RGB PCA WORKER.";
    elements.trainModel.disabled = true;
    elements.trainingEngine.disabled = true;
    trainingWorker = new Worker(
      new URL("../workers/pca-trainer.worker.js", import.meta.url),
      { type: "module" },
    );

    const finishWorker = () => {
      trainingWorker?.terminate();
      trainingWorker = null;
      elements.trainingEngine.disabled = false;
      updateTrainButtonState();
    };

    trainingWorker.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "progress") {
        elements.trainingProgress.value = message.value;
        elements.trainingStatus.textContent = message.message;
        return;
      }
      if (message.type === "complete") {
        CustomModelStore.save(message.model);
        registry.refreshCustom();
        refreshModelOptions(getCurrentModel().id);
        updateCustomModelPanel();
        elements.trainingProgress.value = 100;
        elements.trainingStatus.textContent = `${message.model.name} READY. ${message.model.basis.length} COLOR COMPONENTS RETAINED.`;
        terminal(
          "LOCAL MODEL",
          `${message.model.name} trained from ${message.model.trainingSamples} RGB samples`,
        );
        finishWorker();
        updateResourceStatus();
        setStatus("LOCAL COLOR MODEL READY");
        return;
      }
      if (message.type === "error") {
        elements.trainingStatus.textContent = `TRAINING ERROR: ${message.message}`;
        terminal("TRAINING ERROR", message.message, "warning");
        finishWorker();
        setStatus("TRAINING ERROR");
      }
    });

    trainingWorker.addEventListener("error", (event) => {
      elements.trainingStatus.textContent = `WORKER ERROR: ${event.message}`;
      terminal("WORKER ERROR", event.message, "warning");
      finishWorker();
    });

    trainingWorker.postMessage({
      type: "train",
      payload: {
        samples: studioSamples.map((sample) =>
          resampleRgbPixels(
            sample.pixels,
            STUDIO_SAMPLE_SIZE,
            PCA_TRAINING_SIZE,
          ),
        ),
        sources: studioSamples.map((sample) => sample.source),
        width: PCA_TRAINING_SIZE,
        height: PCA_TRAINING_SIZE,
        channels: 3,
        components: Number(elements.studioComponents.value),
        name,
      },
    });
  }

  function trainLocalModel() {
    if (currentTrainingEngine() === "pca") trainPcaModel();
    else trainNeuralModel();
  }

  function exportCustomModel() {
    const model = CustomModelStore.load();
    if (!model) return;
    const blob = new Blob([JSON.stringify(model, null, 2)], {
      type: "application/json",
    });
    downloadBlob(blob, `${model.name}.latent-field-model.json`);
    terminal("MODEL FILE", `${model.name}.latent-field-model.json written`);
  }

  async function importCustomModel(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const model = validateCustomModel(parsed);
      CustomModelStore.save(model);
      registry.refreshCustom();
      refreshModelOptions(getCurrentModel().id);
      updateCustomModelPanel();
      elements.trainingStatus.textContent = `${model.name} IMPORTED.`;
      terminal(
        "MODEL IMPORT",
        `${model.name} / ${model.width}px / ${model.basis.length} components`,
      );
      setStatus("MODEL IMPORTED");
    } catch (error) {
      elements.trainingStatus.textContent = `IMPORT ERROR: ${error instanceof Error ? error.message : String(error)}`;
      terminal(
        "IMPORT ERROR",
        error instanceof Error ? error.message : String(error),
        "warning",
      );
    } finally {
      elements.importModel.value = "";
    }
  }

  function deleteCustomModel() {
    const model = CustomModelStore.load();
    if (!model) return;
    if (!window.confirm(`Delete local model ${model.name}?`)) return;
    CustomModelStore.clear();
    registry.refreshCustom();
    if (getCurrentModel().id === "custom-pca")
      selectModel("digiface-vae", { log: false });
    refreshModelOptions(getCurrentModel().id);
    updateCustomModelPanel();
    elements.trainingStatus.textContent = "LOCAL MODEL DELETED.";
    terminal("LOCAL MODEL", "deleted", "warning");
    setStatus("LOCAL MODEL DELETED");
  }

  function launchCustomModel() {
    registry.refreshCustom();
    const model = registry.get("custom-pca");
    if (!model.available) return;
    refreshModelOptions("custom-pca");
    navigate("lab");
    selectModel("custom-pca");
  }

  function licenseMatchesFilter(result, filter) {
    const group = licenseGroup(result.license);
    if (filter === "all") return true;
    if (filter === "reusable") return group !== "other";
    return group === filter;
  }

  async function addCommonsResult(result, button) {
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = "FETCHING";
    try {
      const response = await fetch(result.thumbnailUrl, { mode: "cors" });
      if (!response.ok)
        throw new Error(`Image server returned ${response.status}.`);
      const blob = await response.blob();
      const extension = blob.type.includes("png")
        ? "png"
        : blob.type.includes("webp")
          ? "webp"
          : "jpg";
      const file = new File(
        [blob],
        `${result.title.replace(/[^a-z0-9]+/gi, "_").slice(0, 60)}.${extension}`,
        { type: blob.type || "image/jpeg" },
      );
      const sample = await fileToSample(file, {
        title: result.title,
        creator: result.artist,
        license: result.license,
        sourceUrl: result.descriptionUrl,
      });
      addStudioSample(sample.pixels, sample.name, sample.source);
      button.textContent = "ADDED";
      elements.commonsStatus.textContent = `${result.title.toUpperCase()} ADDED TO EXPERIMENTS. ${studioSamples.length} TOTAL SAMPLES.`;
      setStatus("OPEN IMAGE ADDED TO STUDIO");
    } catch (error) {
      button.textContent = originalLabel;
      button.disabled = false;
      elements.commonsStatus.textContent = `DIRECT IMPORT FAILED: ${error instanceof Error ? error.message : String(error)} DOWNLOAD FROM THE SOURCE PAGE AND UPLOAD IT IN EXPERIMENTS.`;
      terminal(
        "IMPORT",
        "browser blocked direct image fetch; use the source download",
        "warning",
      );
    }
  }

  function renderCommonsResults(results, filter) {
    elements.commonsResults.replaceChildren();
    const filtered = results.filter((result) =>
      licenseMatchesFilter(result, filter),
    );
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "commons-empty";
      empty.textContent = "NO RESULTS MATCH THE SELECTED LICENSE FILTER.";
      elements.commonsResults.append(empty);
      return 0;
    }
    filtered.forEach((result) => {
      const card = document.createElement("article");
      card.className = "commons-card";
      const image = document.createElement("img");
      image.src = result.thumbnailUrl;
      image.alt = result.title;
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      const body = document.createElement("div");
      body.className = "commons-card__body";
      const license = document.createElement("span");
      license.className = "commons-card__license";
      license.textContent = result.license;
      const title = document.createElement("h3");
      title.textContent = result.title;
      const creator = document.createElement("p");
      creator.textContent = result.artist || "Unknown creator";
      const dimensions = document.createElement("p");
      dimensions.className = "commons-card__meta";
      dimensions.textContent = `${result.width || "?"} x ${result.height || "?"} / ${result.mime || "image"}`;
      const actions = document.createElement("div");
      actions.className = "commons-card__actions";
      const add = document.createElement("button");
      add.type = "button";
      add.className = "mini-button mini-button--active";
      add.textContent = "ADD TO STUDIO";
      add.addEventListener("click", () => addCommonsResult(result, add));
      const source = document.createElement("a");
      source.className = "mini-button";
      source.href = result.descriptionUrl;
      source.target = "_blank";
      source.rel = "noopener noreferrer";
      source.textContent = "SOURCE + LICENSE";
      actions.append(add, source);
      body.append(license, title, creator, dimensions, actions);
      card.append(image, body);
      elements.commonsResults.append(card);
    });
    return filtered.length;
  }

  async function runCommonsSearch(event) {
    event?.preventDefault();
    const query = elements.commonsInput.value.trim();
    if (!query) {
      elements.commonsStatus.textContent = "ENTER SEARCH TERMS.";
      return;
    }
    commonsAbortController?.abort();
    commonsAbortController = new AbortController();
    const requestController = commonsAbortController;
    elements.commonsButton.disabled = true;
    elements.commonsButton.textContent = "SEARCHING";
    elements.commonsStatus.textContent =
      "QUERYING WIKIMEDIA COMMONS AND READING PER-FILE LICENSE METADATA.";
    try {
      const results = await searchCommons(query, {
        limit: 32,
        signal: requestController.signal,
      });
      if (requestController !== commonsAbortController) return;
      const count = renderCommonsResults(
        results,
        elements.commonsLicense.value,
      );
      elements.commonsStatus.textContent = `${count} RESULTS DISPLAYED. VERIFY EACH SOURCE PAGE BEFORE REUSE.`;
      setStatus(`${count} OPEN MEDIA RESULTS`);
    } catch (error) {
      if (error?.name === "AbortError") return;
      elements.commonsResults.replaceChildren();
      elements.commonsStatus.textContent = `SEARCH FAILED: ${error instanceof Error ? error.message : String(error)} INTERNET ACCESS IS REQUIRED.`;
      terminal(
        "DATASET SEARCH",
        error instanceof Error ? error.message : String(error),
        "warning",
      );
    } finally {
      if (requestController === commonsAbortController) {
        elements.commonsButton.disabled = false;
        elements.commonsButton.textContent = "SEARCH";
      }
    }
  }

  function clearDataset() {
    if (datasetPreparing || trainingBusy()) return;
    studioSamples = [];
    renderSampleGrid();
    elements.trainingStatus.textContent = "LOCAL DATASET CLEARED.";
  }

  function attachEvents() {
    const options = { signal: eventController.signal };
    elements.drawCanvas.addEventListener(
      "pointerdown",
      (event) => {
        drawing = true;
        previousDrawPoint = drawPosition(event);
        elements.drawCanvas.setPointerCapture(event.pointerId);
        drawStroke(event);
      },
      options,
    );
    elements.drawCanvas.addEventListener("pointermove", drawStroke, options);
    ["pointerup", "pointercancel", "pointerleave"].forEach((type) => {
      elements.drawCanvas.addEventListener(
        type,
        () => {
          drawing = false;
          previousDrawPoint = null;
        },
        options,
      );
    });
    elements.clearDrawing.addEventListener("click", clearDrawingPad, options);
    elements.addDrawing.addEventListener("click", addDrawingSample, options);
    elements.imageUpload.addEventListener(
      "change",
      () => addUploadedFiles(elements.imageUpload.files),
      options,
    );
    elements.addSyntheticSet.addEventListener(
      "click",
      addDigiFaceModelSet,
      options,
    );
    elements.clearDataset.addEventListener("click", clearDataset, options);
    elements.trainingEngine.addEventListener(
      "change",
      () => updateTrainingEngineUi({ announce: true }),
      options,
    );
    elements.benchmarkTraining.addEventListener(
      "click",
      () => benchmarkNeuralHardware({ force: true }),
      options,
    );
    elements.stopTraining.addEventListener(
      "click",
      () => {
        trainingManager.stop();
        elements.trainingStatus.textContent =
          "STOP REQUESTED. KEEPING THE BEST WEIGHTS SEEN SO FAR.";
        setStatus("STOPPING NEURAL TRAINING");
      },
      options,
    );
    elements.studioComponents.addEventListener(
      "input",
      () => {
        elements.studioComponentsOutput.textContent =
          elements.studioComponents.value;
      },
      options,
    );
    elements.trainModel.addEventListener("click", trainLocalModel, options);
    elements.exportModel.addEventListener("click", exportCustomModel, options);
    elements.importModel.addEventListener(
      "change",
      () => importCustomModel(elements.importModel.files?.[0]),
      options,
    );
    elements.deleteModel.addEventListener("click", deleteCustomModel, options);
    elements.deleteNeuralModel.addEventListener(
      "click",
      deleteNeuralModel,
      options,
    );
    elements.launchCustom.addEventListener("click", launchCustomModel, options);
    elements.launchNeural.addEventListener("click", launchNeuralModel, options);
    elements.openDatasetsFromStudio.addEventListener(
      "click",
      () => {
        navigate("experiments");
        elements.datasetLibrary.open = true;
        elements.datasetLibrary.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      },
      options,
    );
    elements.commonsForm.addEventListener("submit", runCommonsSearch, options);
    elements.commonsLicense.addEventListener(
      "change",
      () => {
        if (elements.commonsResults.childElementCount) runCommonsSearch();
      },
      options,
    );
  }

  function refreshPanels() {
    updateCustomModelPanel();
    updateNeuralModelPanel();
    updateTrainingEngineUi();
  }

  function initialize() {
    clearDrawingPad();
    renderSampleGrid();
    refreshPanels();
    attachEvents();
  }

  function dispose() {
    eventController.abort();
    commonsAbortController?.abort();
    trainingWorker?.terminate();
    trainingWorker = null;
    trainingManager.stop();
  }

  return Object.freeze({
    initialize,
    refreshPanels,
    dispose,
  });
}
