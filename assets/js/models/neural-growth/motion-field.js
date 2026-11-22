// Small, periodic velocity fields measured in simulation cells per NCA update.
export const MOTION_GRID_SIZE = 16;
export const MOTION_MAX_SPEED = 0.05;
const SAFE_SPEED = MOTION_MAX_SPEED * (1 - 1e-6);

export function limitMotionField(values) {
  if (
    !(values instanceof Float32Array) ||
    values.length !== MOTION_GRID_SIZE ** 2 * 2
  )
    throw new RangeError(
      "Motion field must contain 16×16 finite dx/dy vectors.",
    );
  const result = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 2) {
    const x = values[i],
      y = values[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new RangeError("Motion vectors must be finite.");
    const scale = Math.min(1, SAFE_SPEED / (Math.hypot(x, y) || 1));
    result[i] = x * scale;
    result[i + 1] = y * scale;
  }
  return result;
}

export function motionFieldStats(field) {
  const n = MOTION_GRID_SIZE;
  let energy = 0,
    max = 0,
    divergence = 0,
    neighborDelta = 0;
  const at = (x, y, c) => field[(((y + n) % n) * n + ((x + n) % n)) * 2 + c];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const speed = Math.hypot(at(x, y, 0), at(x, y, 1));
      energy += speed ** 2;
      max = Math.max(max, speed);
      divergence +=
        ((at(x + 1, y, 0) -
          at(x - 1, y, 0) +
          at(x, y + 1, 1) -
          at(x, y - 1, 1)) /
          2) **
        2;
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ])
        neighborDelta = Math.max(
          neighborDelta,
          Math.hypot(
            at(x + dx, y + dy, 0) - at(x, y, 0),
            at(x + dx, y + dy, 1) - at(x, y, 1),
          ),
        );
    }
  return {
    maxSpeed: max,
    rmsSpeed: Math.sqrt(energy / (n * n)),
    divergenceRms: Math.sqrt(divergence / (n * n)),
    maxNeighborDelta: neighborDelta,
  };
}

// A separable DFT is inexpensive on this 16² grid. Project out the central-
// difference divergence and mean translation without introducing pressure sinks.
function transform(real, imaginary, inverse = false) {
  const n = MOTION_GRID_SIZE,
    sign = inverse ? 1 : -1;
  let re = real.slice(),
    im = imaginary.slice();
  for (const vertical of [false, true]) {
    const nextRe = new Float64Array(n * n),
      nextIm = new Float64Array(n * n);
    for (let row = 0; row < n; row++)
      for (let k = 0; k < n; k++) {
        let a = 0,
          b = 0;
        for (let j = 0; j < n; j++) {
          const i = vertical ? j * n + row : row * n + j;
          const angle = (sign * 2 * Math.PI * k * j) / n;
          const c = Math.cos(angle),
            s = Math.sin(angle);
          a += re[i] * c - im[i] * s;
          b += re[i] * s + im[i] * c;
        }
        const i = vertical ? k * n + row : row * n + k;
        nextRe[i] = a / (inverse ? n : 1);
        nextIm[i] = b / (inverse ? n : 1);
      }
    re = nextRe;
    im = nextIm;
  }
  return [re, im];
}

export function constrainMotionField(field, previous = null) {
  const n = MOTION_GRID_SIZE;
  limitMotionField(field); // Validate before filtering or projection.
  let filtered = Float64Array.from(field);
  const weights = [
    0.054488685, 0.244201342, 0.402619946, 0.244201342, 0.054488685,
  ];
  for (const vertical of [false, true]) {
    const result = new Float64Array(field.length);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        for (let c = 0; c < 2; c++)
          for (let d = -2; d <= 2; d++) {
            const sx = (x + (vertical ? 0 : d) + n) % n;
            const sy = (y + (vertical ? d : 0) + n) % n;
            result[(y * n + x) * 2 + c] +=
              filtered[(sy * n + sx) * 2 + c] * weights[d + 2];
          }
    filtered = result;
  }
  const [xr, xi] = transform(
    Float64Array.from({ length: n * n }, (_, i) => filtered[i * 2]),
    new Float64Array(n * n),
  );
  const [yr, yi] = transform(
    Float64Array.from({ length: n * n }, (_, i) => filtered[i * 2 + 1]),
    new Float64Array(n * n),
  );
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const kx = Math.sin((2 * Math.PI * x) / n),
        ky = Math.sin((2 * Math.PI * y) / n);
      const denominator = kx * kx + ky * ky;
      if (denominator < 1e-12) {
        xr[i] = xi[i] = yr[i] = yi[i] = 0;
        continue;
      }
      const real = (kx * xr[i] + ky * yr[i]) / denominator;
      const imaginary = (kx * xi[i] + ky * yi[i]) / denominator;
      xr[i] -= kx * real;
      yr[i] -= ky * real;
      xi[i] -= kx * imaginary;
      yi[i] -= ky * imaginary;
    }
  const vx = transform(xr, xi, true)[0],
    vy = transform(yr, yi, true)[0];
  const projected = Float32Array.from({ length: field.length }, (_, i) =>
    i % 2 ? vy[Math.floor(i / 2)] : vx[Math.floor(i / 2)],
  );
  const stats = motionFieldStats(projected);
  // Global scaling preserves the divergence projection, unlike clipping nodes independently.
  const scale = Math.min(
    1,
    SAFE_SPEED / (stats.maxSpeed || 1),
    0.02 / (stats.maxNeighborDelta || 1),
  );
  for (let i = 0; i < projected.length; i++) projected[i] *= scale;
  if (previous) {
    let maxChange = 0;
    for (let i = 0; i < projected.length; i += 2)
      maxChange = Math.max(
        maxChange,
        Math.hypot(
          projected[i] - previous[i],
          projected[i + 1] - previous[i + 1],
        ),
      );
    const blend = Math.min(1, 0.005 / (maxChange || 1));
    for (let i = 0; i < projected.length; i++)
      projected[i] = previous[i] + (projected[i] - previous[i]) * blend;
  }
  return projected;
}
