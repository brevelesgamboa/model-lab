import { ensureTensorFlow } from "../training/tf-runtime.js";

const OLD_BRAND = ["unknown", "sight"].join("-");
const CURRENT_SCHEMA = "latent-field-local-neural-v1";
const LEGACY_SCHEMA = OLD_BRAND + "-local-neural-v2";
const META_KEY = "latent-field-local-neural-v1";
const LEGACY_META_KEY = OLD_BRAND + "-local-neural-v2";
const ENCODER_URL = "indexeddb://latent-field-local-neural-encoder-v1";
const DECODER_URL = "indexeddb://latent-field-local-neural-decoder-v1";
const LEGACY_ENCODER_URL =
  "indexeddb://" + OLD_BRAND + "-local-neural-encoder-v2";
const LEGACY_DECODER_URL =
  "indexeddb://" + OLD_BRAND + "-local-neural-decoder-v2";

function validateMetadata(input) {
  if (!input || typeof input !== "object")
    throw new Error("Neural model metadata is invalid.");
  if (![CURRENT_SCHEMA, LEGACY_SCHEMA].includes(input.schema))
    throw new Error("Unsupported neural model schema.");
  if (!Number.isInteger(input.inputSize) || input.inputSize !== 128)
    throw new Error("Neural model input size must be 128.");
  if (!Number.isInteger(input.latentDim) || input.latentDim !== 64)
    throw new Error("Neural model latent size must be 64.");
  if (input.profile !== "datamosh")
    throw new Error("Neural model profile must be datamosh.");
  if (input.objective !== "reconstruct")
    throw new Error("Neural model objective must be reconstruct.");

  const metadata = { ...input, schema: CURRENT_SCHEMA };
  if (input.storage) {
    const prefix = "indexeddb://latent-field-local-neural-";
    if (
      ![input.storage.encoder, input.storage.decoder].every(
        (url) => typeof url === "string" && url.startsWith(prefix),
      )
    ) {
      throw new Error("Neural storage references are invalid.");
    }
    metadata.storage = {
      encoder: input.storage.encoder,
      decoder: input.storage.decoder,
    };
  }
  metadata.name = String(metadata.name || "LOCAL_NEURAL_01").slice(0, 32);
  metadata.sampleNames = Array.isArray(metadata.sampleNames)
    ? metadata.sampleNames
        .map((value) => String(value).slice(0, 80))
        .slice(0, 64)
    : [];
  metadata.sampleLatents = Array.isArray(metadata.sampleLatents)
    ? metadata.sampleLatents.slice(0, 64).map((latent) =>
        Array.from(latent || [])
          .slice(0, metadata.latentDim)
          .map(Number),
      )
    : [];
  if (
    metadata.sampleLatents.some(
      (latent) =>
        latent.length !== metadata.latentDim || !latent.every(Number.isFinite),
    )
  ) {
    throw new Error("Stored latent vectors must contain 64 finite values.");
  }
  metadata.trainingSamples =
    Number(metadata.trainingSamples) || metadata.sampleLatents.length;
  metadata.lossHistory = Array.isArray(metadata.lossHistory)
    ? metadata.lossHistory.slice(-180).map((item) => ({
        epoch: Number(item.epoch) || 0,
        loss: Number(item.loss),
        elapsedSeconds: Number(item.elapsedSeconds) || 0,
      }))
    : [];
  metadata.backend = String(metadata.backend || "unknown");
  metadata.quality = String(metadata.quality || "high");
  metadata.finalLoss = Number(metadata.finalLoss ?? NaN);
  metadata.bestLoss = Number(metadata.bestLoss ?? metadata.finalLoss);
  metadata.epochs = Number(metadata.epochs) || 0;
  metadata.trainingSeconds = Number(metadata.trainingSeconds) || 0;
  metadata.createdAt = metadata.createdAt || new Date().toISOString();
  return metadata;
}

async function removeIfPresent(tf, url) {
  try {
    await tf.io.removeModel(url);
  } catch {
    // IndexedDB returns an error when there is no model at this URL. That is fine.
  }
}

export const NeuralModelStore = {
  loadMetadata() {
    try {
      const currentRaw = window.localStorage.getItem(META_KEY);
      const raw = currentRaw || window.localStorage.getItem(LEGACY_META_KEY);
      if (!raw) return null;
      const metadata = validateMetadata(JSON.parse(raw));
      metadata._legacyStorage = !currentRaw;
      return metadata;
    } catch (error) {
      console.warn("Neural model metadata could not be loaded.", error);
      return null;
    }
  },

  async save({ encoder, decoder, metadata }) {
    const tf = await ensureTensorFlow();
    const previous = this.loadMetadata();
    const id = crypto.randomUUID();
    const storage = {
      encoder: `indexeddb://latent-field-local-neural-encoder-${id}`,
      decoder: `indexeddb://latent-field-local-neural-decoder-${id}`,
    };
    const valid = validateMetadata({
      ...metadata,
      schema: CURRENT_SCHEMA,
      inputSize: 128,
      storage,
    });
    try {
      await encoder.save(storage.encoder);
      await decoder.save(storage.decoder);
      // This pointer is the commit: existing weights stay usable until both new models are stored.
      window.localStorage.setItem(META_KEY, JSON.stringify(valid));
    } catch (error) {
      await Promise.all([
        removeIfPresent(tf, storage.encoder),
        removeIfPresent(tf, storage.decoder),
      ]);
      throw error;
    }
    if (previous) {
      const oldEncoder =
        previous.storage?.encoder ||
        (previous._legacyStorage ? LEGACY_ENCODER_URL : ENCODER_URL);
      const oldDecoder =
        previous.storage?.decoder ||
        (previous._legacyStorage ? LEGACY_DECODER_URL : DECODER_URL);
      await Promise.all([
        removeIfPresent(tf, oldEncoder),
        removeIfPresent(tf, oldDecoder),
      ]);
    }
    return valid;
  },

  async loadModels() {
    const metadata = this.loadMetadata();
    if (!metadata) throw new Error("No local neural model metadata is stored.");
    const tf = await ensureTensorFlow();
    const encoderUrl =
      metadata.storage?.encoder ||
      (metadata._legacyStorage ? LEGACY_ENCODER_URL : ENCODER_URL);
    const decoderUrl =
      metadata.storage?.decoder ||
      (metadata._legacyStorage ? LEGACY_DECODER_URL : DECODER_URL);
    const results = await Promise.allSettled([
      tf.loadLayersModel(encoderUrl),
      tf.loadLayersModel(decoderUrl),
    ]);
    if (results.some((result) => result.status === "rejected")) {
      results.forEach((result) => {
        if (result.status === "fulfilled") result.value.dispose();
      });
      throw new Error(
        "Stored model weights could not be loaded. Restore a backup or retrain the model.",
      );
    }
    return { encoder: results[0].value, decoder: results[1].value, metadata };
  },

  async clear() {
    const metadata = this.loadMetadata();
    const tf = await ensureTensorFlow();
    window.localStorage.removeItem(META_KEY);
    window.localStorage.removeItem(LEGACY_META_KEY);
    await Promise.all([
      ...(metadata?.storage
        ? [
            removeIfPresent(tf, metadata.storage.encoder),
            removeIfPresent(tf, metadata.storage.decoder),
          ]
        : []),
      removeIfPresent(tf, ENCODER_URL),
      removeIfPresent(tf, DECODER_URL),
      removeIfPresent(tf, LEGACY_ENCODER_URL),
      removeIfPresent(tf, LEGACY_DECODER_URL),
    ]);
  },

  validateMetadata,
  encoderUrl: ENCODER_URL,
  decoderUrl: DECODER_URL,
};
