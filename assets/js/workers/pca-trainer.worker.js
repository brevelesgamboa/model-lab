function postProgress(value, message) {
  self.postMessage({ type: "progress", value, message });
}

function jacobiEigenDecomposition(matrix) {
  const size = matrix.length;
  const a = matrix.map((row) => Float64Array.from(row));
  const vectors = Array.from({ length: size }, (_, row) => {
    const values = new Float64Array(size);
    values[row] = 1;
    return values;
  });

  const maximumIterations = Math.max(80, size * size * 80);
  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    let p = 0;
    let q = 1;
    let largest = 0;

    for (let row = 0; row < size; row += 1) {
      for (let column = row + 1; column < size; column += 1) {
        const magnitude = Math.abs(a[row][column]);
        if (magnitude > largest) {
          largest = magnitude;
          p = row;
          q = column;
        }
      }
    }

    if (largest < 1e-10) break;

    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    const angle = 0.5 * Math.atan2(2 * apq, aqq - app);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);

    for (let index = 0; index < size; index += 1) {
      if (index === p || index === q) continue;
      const aip = a[index][p];
      const aiq = a[index][q];
      const newP = cosine * aip - sine * aiq;
      const newQ = sine * aip + cosine * aiq;
      a[index][p] = newP;
      a[p][index] = newP;
      a[index][q] = newQ;
      a[q][index] = newQ;
    }

    a[p][p] =
      cosine * cosine * app - 2 * sine * cosine * apq + sine * sine * aqq;
    a[q][q] =
      sine * sine * app + 2 * sine * cosine * apq + cosine * cosine * aqq;
    a[p][q] = 0;
    a[q][p] = 0;

    for (let row = 0; row < size; row += 1) {
      const vip = vectors[row][p];
      const viq = vectors[row][q];
      vectors[row][p] = cosine * vip - sine * viq;
      vectors[row][q] = sine * vip + cosine * viq;
    }
  }

  return {
    values: Array.from({ length: size }, (_, index) => a[index][index]),
    vectors,
  };
}

function train({
  samples,
  width,
  height,
  channels = 3,
  components,
  name,
  sources = [],
}) {
  if (!Array.isArray(samples) || samples.length < 3)
    throw new Error("At least three samples are required.");
  if (samples.length > 64)
    throw new Error("This build accepts at most 64 samples.");
  if (width !== height || ![32, 48].includes(width))
    throw new Error("Training resolution must be 32 × 32 or 48 × 48.");
  if (![1, 3].includes(channels))
    throw new Error("Training channels must be 1 or 3.");

  const vectorLength = width * height * channels;
  const normalizedSamples = samples.map((sample) => {
    const values =
      sample instanceof Float32Array ? sample : Float32Array.from(sample);
    if (values.length !== vectorLength)
      throw new Error("A training sample has the wrong dimensions.");
    return values;
  });

  postProgress(8, "NORMALIZING INPUT VECTORS");
  const mean = new Float64Array(vectorLength);
  for (const sample of normalizedSamples) {
    for (let index = 0; index < vectorLength; index += 1)
      mean[index] += sample[index];
  }
  for (let index = 0; index < vectorLength; index += 1)
    mean[index] /= normalizedSamples.length;

  const centered = normalizedSamples.map((sample) => {
    const row = new Float64Array(vectorLength);
    for (let index = 0; index < vectorLength; index += 1)
      row[index] = sample[index] - mean[index];
    return row;
  });

  postProgress(28, "COMPUTING SAMPLE COVARIANCE");
  const sampleCount = centered.length;
  const denominator = Math.max(1, sampleCount - 1);
  const gram = Array.from(
    { length: sampleCount },
    () => new Float64Array(sampleCount),
  );
  for (let row = 0; row < sampleCount; row += 1) {
    for (let column = row; column < sampleCount; column += 1) {
      let dot = 0;
      for (let index = 0; index < vectorLength; index += 1)
        dot += centered[row][index] * centered[column][index];
      const value = dot / denominator;
      gram[row][column] = value;
      gram[column][row] = value;
    }
  }

  postProgress(52, "SOLVING PRINCIPAL DIRECTIONS");
  const decomposition = jacobiEigenDecomposition(gram);
  const order = decomposition.values
    .map((value, index) => ({ value, index }))
    .filter((entry) => entry.value > 1e-9)
    .sort((a, b) => b.value - a.value);

  if (!order.length)
    throw new Error("The samples do not contain enough visual variation.");
  const requested = Math.max(
    1,
    Math.min(Number(components) || 2, 8, order.length),
  );
  const totalVariance = order.reduce((sum, entry) => sum + entry.value, 0);
  const basis = [];
  const explainedVariance = [];
  const explainedVarianceRatio = [];

  postProgress(72, "PROJECTING BASIS VECTORS");
  for (let component = 0; component < requested; component += 1) {
    const eigen = order[component];
    const vector = new Float64Array(vectorLength);
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const weight = decomposition.vectors[sampleIndex][eigen.index];
      const sample = centered[sampleIndex];
      for (let index = 0; index < vectorLength; index += 1)
        vector[index] += sample[index] * weight;
    }

    let norm = 0;
    for (let index = 0; index < vectorLength; index += 1)
      norm += vector[index] * vector[index];
    norm = Math.sqrt(norm);
    if (norm < 1e-12) continue;
    for (let index = 0; index < vectorLength; index += 1) vector[index] /= norm;

    basis.push(Array.from(vector, (value) => Number(value.toFixed(7))));
    explainedVariance.push(Number(eigen.value.toFixed(8)));
    explainedVarianceRatio.push(
      Number((eigen.value / totalVariance).toFixed(8)),
    );
  }

  if (!basis.length)
    throw new Error("No stable basis vectors could be produced.");
  postProgress(94, "SERIALIZING LOCAL MODEL");

  return {
    schema: "latent-field-local-pca-v1",
    id: "LOCAL_PCA_CUSTOM",
    name,
    version: "1.0.0",
    width,
    height,
    channels,
    colorSpace: channels === 3 ? "srgb" : "grayscale",
    trainingSamples: sampleCount,
    components: basis.length,
    mean: Array.from(mean, (value) => Number(value.toFixed(7))),
    basis,
    explainedVariance,
    explainedVarianceRatio,
    totalVarianceRetained: explainedVarianceRatio.reduce(
      (sum, value) => sum + value,
      0,
    ),
    sources: Array.isArray(sources) ? sources.slice(0, 64) : [],
    createdAt: new Date().toISOString(),
  };
}

self.addEventListener("message", (event) => {
  if (event.data?.type !== "train") return;
  try {
    const model = train(event.data.payload);
    postProgress(100, "MODEL READY");
    self.postMessage({ type: "complete", model });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
