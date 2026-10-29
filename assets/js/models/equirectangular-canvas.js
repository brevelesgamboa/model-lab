const clamp = (n, lo = 0, hi = 255) => Math.max(lo, Math.min(hi, n));
const cosine = (t) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(t, 0, 1));

export function photoPlacement(
  sourceWidth,
  sourceHeight,
  width = 1024,
  height = 512,
) {
  if (
    ![sourceWidth, sourceHeight, width, height].every(
      (n) => Number.isFinite(n) && n > 0,
    ) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width !== height * 2
  )
    throw new RangeError(
      "The panorama must be 2:1 and the photo must have positive dimensions.",
    );
  const scale = Math.min(
    width / 3 / sourceWidth,
    (height * 0.68) / sourceHeight,
  );
  const w = Math.max(1, Math.round(sourceWidth * scale)),
    h = Math.max(1, Math.round(sourceHeight * scale));
  return {
    x: Math.round((width - w) / 2),
    y: Math.round((height - h) / 2),
    width: w,
    height: h,
    feather: Math.min(20, w / 4, h / 4),
  };
}

export function photoProtection(x, y, rect) {
  const distance = Math.min(
    x - rect.x,
    rect.x + rect.width - 1 - x,
    y - rect.y,
    rect.y + rect.height - 1 - y,
  );
  return cosine(distance / Math.max(1, rect.feather));
}

export function borderStatistics(rgba, width, height) {
  const mean = [0, 0, 0],
    square = [0, 0, 0];
  let count = 0,
    seed = 2166136261;
  const band = Math.max(
    1,
    Math.min(3, Math.floor(Math.min(width, height) / 4)),
  );
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (x >= band && x < width - band && y >= band && y < height - band)
        continue;
      count++;
      for (let c = 0; c < 3; c++) {
        const value = rgba[(y * width + x) * 4 + c];
        mean[c] += value;
        square[c] += value * value;
        seed = Math.imul(seed ^ value, 16777619) >>> 0;
      }
    }
  return {
    mean: mean.map((n) => n / count),
    variance: square.map((n, c) =>
      Math.max(0, n / count - (mean[c] / count) ** 2),
    ),
    seed,
  };
}

// Pure pixels make the wrapping, palette and protected photo independently
// verifiable. Noise is evaluated on a coarse periodic lattice, then interpolated.
export function prepare360Pixels(
  photoRgba,
  photoWidth,
  photoHeight,
  width = 1024,
  height = 512,
) {
  if (photoRgba.length !== photoWidth * photoHeight * 4)
    throw new RangeError("Invalid photo pixels.");
  const rect = photoPlacement(photoWidth, photoHeight, width, height);
  const stats = borderStatistics(photoRgba, photoWidth, photoHeight);
  let randomState = stats.seed;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  const waves = Array.from({ length: 9 }, (_, i) => ({
    kx: 1 + (i % 4),
    ky: 1 + Math.floor(i / 3),
    phase: random() * Math.PI * 2,
  }));
  const gridWidth = 65,
    gridHeight = 33,
    grid = new Float32Array(gridWidth * gridHeight * 3);
  for (let y = 0; y < gridHeight; y++)
    for (let x = 0; x < gridWidth; x++) {
      const u = x / (gridWidth - 1),
        v = y / (gridHeight - 1);
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (const wave of waves)
          sum += Math.cos(
            Math.PI * 2 * (wave.kx * u + wave.ky * v) + wave.phase + c * 0.42,
          );
        const sigma = Math.max(16, Math.min(60, Math.sqrt(stats.variance[c])));
        grid[(y * gridWidth + x) * 3 + c] = clamp(
          stats.mean[c] + 4 + (sum / 4) * sigma * Math.sin(Math.PI * v),
          10,
          245,
        );
      }
    }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const gx = (x / (width - 1)) * (gridWidth - 1),
        gy = (y / (height - 1)) * (gridHeight - 1);
      const x0 = Math.floor(gx),
        y0 = Math.floor(gy),
        x1 = Math.min(gridWidth - 1, x0 + 1),
        y1 = Math.min(gridHeight - 1, y0 + 1);
      const fx = gx - x0,
        fy = gy - y0,
        offset = (y * width + x) * 4;
      const alpha = photoProtection(x, y, rect);
      const px = clamp(
        Math.round(
          ((x - rect.x) / Math.max(1, rect.width - 1)) * (photoWidth - 1),
        ),
        0,
        photoWidth - 1,
      );
      const py = clamp(
        Math.round(
          ((y - rect.y) / Math.max(1, rect.height - 1)) * (photoHeight - 1),
        ),
        0,
        photoHeight - 1,
      );
      for (let c = 0; c < 3; c++) {
        const a =
          grid[(y0 * gridWidth + x0) * 3 + c] * (1 - fx) +
          grid[(y0 * gridWidth + x1) * 3 + c] * fx;
        const b =
          grid[(y1 * gridWidth + x0) * 3 + c] * (1 - fx) +
          grid[(y1 * gridWidth + x1) * 3 + c] * fx;
        data[offset + c] =
          (a * (1 - fy) + b * fy) * (1 - alpha) +
          photoRgba[(py * photoWidth + px) * 4 + c] * alpha;
      }
      data[offset + 3] = 255;
    }
  return { data, width, height, photoRect: rect, border: stats };
}

export function create360Canvas(imageElement, width = 1024, height = 512) {
  const iw = imageElement.naturalWidth || imageElement.width,
    ih = imageElement.naturalHeight || imageElement.height;
  const rect = photoPlacement(iw, ih, width, height);
  const makeCanvas = (w, h) =>
    typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement("canvas"), {
          width: w,
          height: h,
        });
  const photo = makeCanvas(rect.width, rect.height),
    ctx = photo.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#08080c";
  ctx.fillRect(0, 0, rect.width, rect.height);
  ctx.drawImage(imageElement, 0, 0, rect.width, rect.height);
  const prepared = prepare360Pixels(
    ctx.getImageData(0, 0, rect.width, rect.height).data,
    rect.width,
    rect.height,
    width,
    height,
  );
  // Input is already resized to the intended placement; keep that exact rectangle.
  const canvas = makeCanvas(width, height);
  canvas
    .getContext("2d")
    .putImageData(new ImageData(prepared.data, width, height), 0, 0);
  canvas.photoRect = prepared.photoRect;
  return canvas;
}

// Project CPU top-down scalar maps into the same full panorama as the photo.
export function projectPhotoMap(
  values,
  mapWidth,
  mapHeight,
  rect,
  panoramaWidth = 1024,
  panoramaHeight = 512,
) {
  const width = 256,
    height = 128,
    depth = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const px = (x / (width - 1)) * (panoramaWidth - 1),
        py = (y / (height - 1)) * (panoramaHeight - 1);
      const alpha = photoProtection(px, py, rect);
      if (!alpha) continue;
      const mx =
        clamp((px - rect.x) / Math.max(1, rect.width - 1), 0, 1) *
        (mapWidth - 1);
      const my =
        clamp((py - rect.y) / Math.max(1, rect.height - 1), 0, 1) *
        (mapHeight - 1);
      const x0 = Math.floor(mx),
        y0 = Math.floor(my),
        x1 = Math.min(mapWidth - 1, x0 + 1),
        y1 = Math.min(mapHeight - 1, y0 + 1),
        fx = mx - x0,
        fy = my - y0;
      depth[y * width + x] =
        alpha *
        ((values[y0 * mapWidth + x0] * (1 - fx) +
          values[y0 * mapWidth + x1] * fx) *
          (1 - fy) +
          (values[y1 * mapWidth + x0] * (1 - fx) +
            values[y1 * mapWidth + x1] * fx) *
            fy);
    }
  return { width, height, depth };
}
