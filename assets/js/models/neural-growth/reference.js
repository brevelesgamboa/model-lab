// Numerical reference for the exported Texture NCA RGBA8 profile.
// Profile provenance and upstream licenses: models/neural-growth/NOTICE.md.

export const CHANNELS = 12;
export const PROFILE = "latent-field-texture-nca-v1";
const LAYER_SHAPES = [
  [49, 96],
  [97, 12],
];
const CENTER = Math.fround(127 / 255);
const NORMALIZED_BYTES = Float32Array.from(
  { length: 256 },
  (_, byte) => byte / 255,
);
const DECODED_BYTES = Float32Array.from(NORMALIZED_BYTES, (value) =>
  Math.fround((value - CENTER) * 4),
);
const FILTERS = [
  [0, 0, 0, 0, 8, 0, 0, 0, 0],
  [-1, 0, 1, -2, 0, 2, -1, 0, 1],
  [-1, -2, -1, 0, 0, 0, 1, 2, 1],
  [1, 2, 1, 2, -12, 2, 1, 2, 1],
];

export function validateSize(size) {
  if (!Number.isInteger(size) || size < 8 || size > 256 || size & (size - 1)) {
    throw new RangeError("Grid size must be a power of two between 8 and 256.");
  }
  return size;
}

export function validateSeed(seed) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError("Seed must be an unsigned 32-bit integer.");
  }
  return seed;
}

export function validateStartup(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid checkpoint startup settings.");
  }
  const seedState = input.seedState ?? "zeros";
  if (seedState !== "zeros" && seedState !== "noise") {
    throw new Error("Startup state must be zeros or noise.");
  }
  const noiseStd = input.noiseStd ?? (seedState === "noise" ? 0.05 : 0);
  if (
    !Number.isFinite(noiseStd) ||
    noiseStd < 0 ||
    noiseStd > 1 ||
    (seedState === "noise" && noiseStd === 0)
  ) {
    throw new Error("Invalid startup noise standard deviation.");
  }
  const previewSteps = input.previewSteps ?? 96;
  if (!Number.isInteger(previewSteps) || previewSteps < 1 || previewSteps > 10000) {
    throw new Error("Invalid preview step count.");
  }
  return Object.freeze({
    seedState,
    noiseStd,
    seed: validateSeed(input.seed ?? 1),
    gridSize: validateSize(input.gridSize ?? 128),
    previewSteps,
  });
}

export function validateCheckpoint(input) {
  if (!input || input.format !== PROFILE)
    throw new Error("Unsupported Texture NCA profile.");
  if (typeof input.id !== "string" || !/^[a-z0-9_-]{1,64}$/.test(input.id)) {
    throw new Error("Invalid checkpoint identifier.");
  }
  if (
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 80
  ) {
    throw new Error("Invalid checkpoint name.");
  }
  if (!Array.isArray(input.layers) || input.layers.length !== 2) {
    throw new Error("This profile requires two dense layers.");
  }
  const layers = input.layers.map((layer, index) => {
    const [rows, columns] = LAYER_SHAPES[index];
    if (
      !layer ||
      !Array.isArray(layer.shape) ||
      layer.shape.length !== 2 ||
      layer.shape[0] !== rows ||
      layer.shape[1] !== columns
    ) {
      throw new Error(
        "Checkpoint architecture does not match the RGBA8 profile.",
      );
    }
    if (!Number.isFinite(layer.scale) || layer.scale <= 0 || layer.scale > 8) {
      throw new Error("Invalid weight scale.");
    }
    if (
      (!Array.isArray(layer.weights) &&
        !(layer.weights instanceof Uint8Array)) ||
      layer.weights.length !== rows * columns
    ) {
      throw new Error("Invalid weight byte count.");
    }
    for (const value of layer.weights) {
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new Error("Weights must contain unsigned bytes only.");
      }
    }
    const weights = Uint8Array.from(layer.weights);
    const coefficients = Float32Array.from(
      weights,
      (byte) => ((byte - 127) * layer.scale) / 255,
    );
    const unscaled = Float32Array.from(weights, (byte) =>
      Math.fround(NORMALIZED_BYTES[byte] - CENTER),
    );
    return Object.freeze({
      shape: Object.freeze([rows, columns]),
      scale: layer.scale,
      weights,
      coefficients,
      unscaled,
    });
  });
  return Object.freeze({
    format: PROFILE,
    id: input.id,
    name: input.name,
    startup: validateStartup(input.startup),
    layers: Object.freeze(layers),
  });
}

export function createRandom(seed) {
  let state = validateSeed(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// A fixed uniformly selected half-grid, translated each step as in the reference
// browser implementation. Coordinates deliberately fit in unsigned bytes.
export function createSparseLayout(size, seed) {
  validateSize(size);
  const random = createRandom(seed);
  const cellCount = size * size;
  const selectedCount = cellCount / 2;
  const shuffle = new Uint8Array(selectedCount * 4);
  const inverse = new Uint8Array(cellCount * 4);
  let selected = 0;
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (random() >= (selectedCount - selected) / (cellCount - cell)) continue;
    shuffle[selected * 4] = cell % size;
    shuffle[selected * 4 + 1] = Math.floor(cell / size);
    inverse[cell * 4] = selected % size;
    inverse[cell * 4 + 1] = Math.floor(selected / size);
    inverse[cell * 4 + 2] = 255;
    selected += 1;
  }
  return { shuffle, inverse, random };
}

const decode = (byte) => DECODED_BYTES[byte];
const encode = (value) =>
  Math.min(
    255,
    Math.max(0, Math.round(Math.fround(Math.fround(value / 4) + CENTER) * 255)),
  );
const quantizeHidden = (value) => {
  const byte = Math.min(
    255,
    Math.max(0, Math.round(Math.fround(value / 2) * 255)),
  );
  return Math.fround(NORMALIZED_BYTES[byte] * 2);
};

// Gaussian initialization uses an independent seeded stream. It matches the
// training noise distribution, not PyTorch's random sequence or saved pool state.
export function createInitialState(size, seed, startup = {}) {
  validateSize(size);
  validateSeed(seed);
  const settings = validateStartup(startup);
  const state = new Uint8Array(size * size * CHANNELS).fill(127);
  if (settings.seedState === "zeros") return state;
  const random = createRandom((seed ^ 0x9e3779b9) >>> 0);
  for (let index = 0; index < state.length; index += 2) {
    const radius = Math.sqrt(-2 * Math.log(1 - random())) * settings.noiseStd;
    const angle = 2 * Math.PI * random();
    state[index] = encode(radius * Math.cos(angle));
    state[index + 1] = encode(radius * Math.sin(angle));
  }
  return state;
}

function dense(input, layer, hidden) {
  const [rows, columns] = layer.shape;
  const output = new Float32Array(columns);
  for (let column = 0; column < columns; column += 1) {
    let sum = 0;
    for (let row = 0; row < rows - 1; row += 1) {
      sum = Math.fround(
        sum + Math.fround(input[row] * layer.unscaled[row * columns + column]),
      );
    }
    // The exported shader scales only after the entire dot product plus bias.
    // Algebraically folding scale into each weight changes rounding boundaries.
    sum = Math.fround(
      Math.fround(sum + layer.unscaled[(rows - 1) * columns + column]) *
        Math.fround(layer.scale),
    );
    output[column] = hidden ? quantizeHidden(sum) : decode(encode(sum));
  }
  return output;
}

function perceiveCell(state, size, cell) {
  const x = cell % size;
  const y = Math.floor(cell / size);
  const perception = new Float32Array(CHANNELS * FILTERS.length);
  for (let band = 0; band < FILTERS.length; band += 1) {
    for (let channel = 0; channel < CHANNELS; channel += 1) {
      let sum = 0;
      for (let ky = 0; ky < 3; ky += 1) {
        for (let kx = 0; kx < 3; kx += 1) {
          const weight = FILTERS[band][ky * 3 + kx];
          if (!weight) continue;
          const sx = (x + kx - 1 + size) % size;
          const sy = (y + ky - 1 + size) % size;
          sum += (state[(sy * size + sx) * CHANNELS + channel] - 127) * weight;
        }
      }
      perception[band * CHANNELS + channel] = decode(encodePerception(sum));
    }
  }
  return perception;
}

export function encodePerception(weightedSum) {
  if (!Number.isSafeInteger(weightedSum)) {
    throw new TypeError("Perception accumulator must be an integer.");
  }
  return Math.min(
    255,
    Math.max(0, Math.floor((weightedSum + 127 * 8 + 4) / 8)),
  );
}

// Diagnostic only: encoded intermediate values on a full, small CPU grid.
// Keeping this oracle separate from GPU buffers makes packing/order mistakes
// visible without introducing a second rendering backend.
export function referenceStages(state, model, size) {
  validateSize(size);
  if (
    !(state instanceof Uint8Array) ||
    state.length !== size * size * CHANNELS
  ) {
    throw new Error("State must contain twelve encoded channels per cell.");
  }
  const perceptionBytes = new Uint8Array(size * size * 48);
  const hiddenBytes = new Uint8Array(size * size * 96);
  const deltaBytes = new Uint8Array(size * size * CHANNELS);
  for (let cell = 0; cell < size * size; cell += 1) {
    const perception = perceiveCell(state, size, cell);
    const hidden = dense(perception, model.layers[0], true);
    const delta = dense(hidden, model.layers[1], false);
    perceptionBytes.set(Uint8Array.from(perception, encode), cell * 48);
    hiddenBytes.set(
      Uint8Array.from(hidden, (value) => Math.round((value * 255) / 2)),
      cell * 96,
    );
    deltaBytes.set(Uint8Array.from(delta, encode), cell * CHANNELS);
  }
  return {
    perception: perceptionBytes,
    hidden: hiddenBytes,
    delta: deltaBytes,
  };
}

// Slow, independent CPU oracle for small fixed-state GPU comparisons. It is not
// a display backend: inference stays on the GPU in the prototype.
export function referenceStep(state, model, size, updateMask) {
  validateSize(size);
  const cells = size * size;
  if (!(state instanceof Uint8Array) || state.length !== cells * CHANNELS) {
    throw new Error("State must contain twelve encoded channels per cell.");
  }
  if (
    !(updateMask instanceof Uint8Array) ||
    updateMask.length !== cells ||
    updateMask.some((value) => value !== 0 && value !== 1)
  ) {
    throw new Error("Update mask must contain one binary value per cell.");
  }
  const next = state.slice();
  for (let cell = 0; cell < cells; cell += 1) {
    if (!updateMask[cell]) continue;
    const perception = perceiveCell(state, size, cell);
    const hidden = dense(perception, model.layers[0], true);
    const delta = dense(hidden, model.layers[1], false);
    for (let channel = 0; channel < CHANNELS; channel += 1) {
      const index = cell * CHANNELS + channel;
      next[index] = encode(Math.fround(decode(state[index]) + delta[channel]));
    }
  }
  return next;
}
