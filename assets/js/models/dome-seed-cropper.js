const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const makeCanvas = (width, height) => new OffscreenCanvas(width, height);

// Saliency heuristics, not object recognition. Work on a small preview so even
// large uploads cost one readback and one Sobel pass, rather than nine full scans.
export function semanticAnchorWindows(rgba, width, height) {
  if (width < 1 || height < 1 || rgba.length !== width * height * 4)
    throw new RangeError("Invalid anchor preview dimensions.");
  const light = new Float32Array(width * height),
    energy = new Float32Array(width * height);
  for (let i = 0; i < light.length; i++)
    light[i] = luminance(...rgba.subarray(i * 4, i * 4 + 3)) / 255;
  const at = (x, y) =>
    light[
      Math.max(0, Math.min(height - 1, y)) * width +
        Math.max(0, Math.min(width - 1, x))
    ];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const gx =
        -at(x - 1, y - 1) +
        at(x + 1, y - 1) -
        2 * at(x - 1, y) +
        2 * at(x + 1, y) -
        at(x - 1, y + 1) +
        at(x + 1, y + 1);
      const gy =
        -at(x - 1, y - 1) -
        2 * at(x, y - 1) -
        at(x + 1, y - 1) +
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1);
      energy[y * width + x] = (gx * gx + gy * gy) / 32;
    }
  const candidates = [],
    w = Math.max(1, Math.round(width * 0.6)),
    h = Math.max(1, Math.round(height * 0.6));
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 3; col++) {
      const x = Math.round(((width - w) * col) / 2),
        y = Math.round(((height - h) * row) / 2);
      let sum = 0,
        squares = 0,
        gradient = 0;
      for (let dy = 0; dy < h; dy++)
        for (let dx = 0; dx < w; dx++) {
          const i = (y + dy) * width + x + dx;
          sum += light[i];
          squares += light[i] ** 2;
          gradient += energy[i];
        }
      const mean = sum / (w * h),
        variance = Math.max(0, squares / (w * h) - mean * mean);
      candidates.push({
        x,
        y,
        width: w,
        height: h,
        mean,
        variance,
        detail: gradient / (w * h) + variance * 0.3,
        shadow: (1 - mean) * 0.55 + Math.sqrt(variance) * 0.45,
      });
    }
  const best = (key) => candidates.reduce((a, b) => (b[key] > a[key] ? b : a));
  return { detail: best("detail"), shadow: best("shadow"), candidates };
}

export function extractSemanticAnchors(
  sourceCanvas,
  targetWidth = 512,
  targetHeight = 256,
  createCanvas = makeCanvas,
) {
  if (
    ![
      sourceCanvas?.width,
      sourceCanvas?.height,
      targetWidth,
      targetHeight,
    ].every((n) => Number.isInteger(n) && n > 0)
  )
    throw new RangeError(
      "Anchor canvases must have positive integer dimensions.",
    );
  const preview = createCanvas(
      Math.min(128, sourceCanvas.width),
      Math.min(96, sourceCanvas.height),
    ),
    ctx = preview.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, 0, 0, preview.width, preview.height);
  const windows = semanticAnchorWindows(
    ctx.getImageData(0, 0, preview.width, preview.height).data,
    preview.width,
    preview.height,
  );
  const crop = (rect) => {
    const canvas = createCanvas(targetWidth, targetHeight);
    const bounds = rect
      ? [
          (rect.x / preview.width) * sourceCanvas.width,
          (rect.y / preview.height) * sourceCanvas.height,
          (rect.width / preview.width) * sourceCanvas.width,
          (rect.height / preview.height) * sourceCanvas.height,
        ]
      : [0, 0, sourceCanvas.width, sourceCanvas.height];
    canvas
      .getContext("2d")
      .drawImage(sourceCanvas, ...bounds, 0, 0, targetWidth, targetHeight);
    canvas.sourceRect = bounds;
    return canvas;
  };
  const anchor0 = crop(null),
    anchor1 = crop(windows.detail),
    anchor2 = crop(windows.shadow),
    cyber = anchor2.getContext("2d"),
    image = cyber.getImageData(0, 0, targetWidth, targetHeight);
  for (let i = 0; i < image.data.length; i += 4) {
    const rgb = Array.from(image.data.subarray(i, i + 3), (v) => v / 255),
      y = luminance(...rgb),
      inverted = 0.08 + Math.pow(1 - y, 1.6) * 0.42;
    // Subtle +120 degree chroma rotation (cyclic RGB permutation), with an
    // inverted luminance curve. Keep texture detail and alpha intact.
    const rotated = [rgb[2], rgb[0], rgb[1]];
    for (let c = 0; c < 3; c++)
      image.data[i + c] =
        Math.max(
          0,
          Math.min(1, inverted + (rgb[c] * 0.8 + rotated[c] * 0.2 - y) * 0.7),
        ) * 255;
  }
  cyber.putImageData(image, 0, 0);
  return { anchor0, anchor1, anchor2 };
}

export function createSeedAnchors(
  sources,
  width = 512,
  height = 256,
  createCanvas = makeCanvas,
) {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 3)
    throw new RangeError("Choose between one and three seed images.");
  const { anchor0, anchor1, anchor2 } = extractSemanticAnchors(
    sources[0],
    width,
    height,
    createCanvas,
  );
  const anchors = [anchor0, anchor1, anchor2];
  for (let i = 1; i < sources.length; i++) {
    anchors[i] = createCanvas(width, height);
    anchors[i].getContext("2d").drawImage(sources[i], 0, 0, width, height);
  }
  return anchors;
}
