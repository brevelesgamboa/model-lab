import { photoProtection } from "./equirectangular-canvas.js";

const luma = (tf, rgb) =>
  rgb.mul(tf.tensor1d([0.299, 0.587, 0.114])).sum(3, true);

// BT.601, with no 128-byte offset in the signed chroma channels.
export function applyDomeColorStep(tf, image, gradient, step, retention = 1) {
  return tf.tidy(() => {
    const dy = luma(tf, gradient).mul(step);
    const cb = gradient
      .mul(tf.tensor1d([-0.168736, -0.331264, 0.5]))
      .sum(3, true)
      .mul(step * (1 - retention));
    const cr = gradient
      .mul(tf.tensor1d([0.5, -0.418688, -0.081312]))
      .sum(3, true)
      .mul(step * (1 - retention));
    return image.add(
      tf.concat(
        [
          dy.add(cr.mul(1.402)),
          dy.sub(cb.mul(0.344136)).sub(cr.mul(0.714136)),
          dy.add(cb.mul(1.772)),
        ],
        3,
      ),
    );
  });
}

export function constrainDomeColor(tf, candidate, base, retention = 1) {
  return tf.tidy(() => {
    // Preserve source chroma even across octaves, seam smoothing and gamut
    // limits. Independent RGB clipping would change hue at saturated pixels.
    const source = retention === 1 ? base : candidate;
    let chroma = source.sub(luma(tf, source));
    const span = chroma.max(3, true).sub(chroma.min(3, true));
    chroma = chroma.div(tf.maximum(span, 1));
    const y = tf.minimum(
      tf.maximum(luma(tf, candidate), chroma.min(3, true).neg()),
      tf.sub(1, chroma.max(3, true)),
    );
    return chroma.add(y).clipByValue(0, 1);
  });
}

export function rollDomeX(tf, image, shift) {
  const width = image.shape[2],
    dx = ((shift % width) + width) % width;
  return dx
    ? tf.concat(
        [
          image.slice([0, 0, width - dx, 0], [-1, -1, dx, -1]),
          image.slice([0, 0, 0, 0], [-1, -1, width - dx, -1]),
        ],
        2,
      )
    : image.clone();
}

function blurGradient(tf, image) {
  let result = image;
  for (let pass = 0; pass < 2; pass++) {
    const horizontal = rollDomeX(tf, result, -1)
      .add(result.mul(2))
      .add(rollDomeX(tf, result, 1))
      .mul(0.25);
    const h = image.shape[1];
    const above = tf.concat(
      [
        horizontal.slice([0, 0, 0, 0], [-1, 1, -1, -1]),
        horizontal.slice([0, 0, 0, 0], [-1, h - 1, -1, -1]),
      ],
      1,
    );
    const below = tf.concat(
      [
        horizontal.slice([0, 1, 0, 0], [-1, h - 1, -1, -1]),
        horizontal.slice([0, h - 1, 0, 0], [-1, 1, -1, -1]),
      ],
      1,
    );
    result = above.add(horizontal.mul(2)).add(below).mul(0.25);
  }
  return result;
}

function constraints(tf, width, height, sourceWidth, sourceHeight, rect) {
  const protect = new Float32Array(width * height),
    seam = new Float32Array(width),
    poles = new Float32Array(height);
  const cosine = (n) =>
    0.5 + 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, n)));
  for (let y = 0; y < height; y++) {
    poles[y] = cosine(
      Math.min(y, height - 1 - y) / Math.max(2, height * 0.025),
    );
    for (let x = 0; x < width; x++)
      protect[y * width + x] = rect
        ? photoProtection(
            (x / (width - 1)) * (sourceWidth - 1),
            (y / (height - 1)) * (sourceHeight - 1),
            rect,
          )
        : 0;
  }
  for (let x = 0; x < width; x++)
    seam[x] = cosine(Math.min(x, width - 1 - x) / Math.max(4, width * 0.016));
  return {
    protect: tf.tensor4d(protect, [1, height, width, 1]),
    seam: tf.tensor4d(seam, [1, 1, width, 1]),
    poles: tf.tensor4d(poles, [1, height, 1, 1]),
  };
}

function project(tf, image, base, c) {
  // Couple neighbors across the wrap, rather than smearing one edge column
  // across a band (which would create an obvious vertical stripe).
  let result = image
    .mul(tf.sub(1, c.seam))
    .add(blurGradient(tf, image).mul(c.seam));
  const rowMean = result.mean(2, true);
  result = result.mul(tf.sub(1, c.poles)).add(rowMean.mul(c.poles));
  // Apply the bidirectional photo feather once: 0 ascent in the protected
  // core, half strength at the edge, full strength outside the 50px band.
  return result.mul(tf.sub(1, c.protect)).add(base.mul(c.protect));
}

// This runs in a dedicated worker in production. TensorFlow/model injection
// keeps the actual ascent, unrolling, constraints and cleanup testable on CPU.
export async function optimizeDomeDream(
  tf,
  model,
  seed,
  {
    node,
    channel,
    photoRect,
    iterations = 15,
    onProgress = () => {},
    signal,
    stepSize = 0.04,
    colorRetention = 1,
  } = {},
) {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100)
    throw new RangeError("Use between 1 and 100 dream iterations.");
  if (
    !Number.isFinite(colorRetention) ||
    colorRetention < 0 ||
    colorRetention > 1
  )
    throw new RangeError("Color retention must be between zero and one.");
  const [, sourceHeight, sourceWidth] = seed.shape;
  const sizes =
    iterations >= 4 && sourceHeight > 128
      ? [
          [Math.round(sourceHeight / 2), Math.round(sourceWidth / 2)],
          [sourceHeight, sourceWidth],
        ]
      : [[sourceHeight, sourceWidth]];
  let image,
    base,
    c,
    completed = 0,
    scoreStart = null,
    scoreEnd = null;
  const started = performance.now();
  try {
    for (let octave = 0; octave < sizes.length; octave++) {
      const [height, width] = sizes[octave];
      base = tf.image.resizeBilinear(seed, [height, width]);
      const initial = image
        ? tf.image.resizeBilinear(image, [height, width])
        : base.clone();
      image?.dispose();
      image = constrainDomeColor(tf, initial, base, colorRetention);
      initial.dispose();
      c = constraints(tf, width, height, sourceWidth, sourceHeight, photoRect);
      const count =
        sizes.length === 1
          ? iterations
          : octave === 0
            ? Math.floor(iterations * 0.4)
            : iterations - Math.floor(iterations * 0.4);
      for (let step = 0; step < count; step++) {
        signal?.throwIfAborted();
        const shift = Math.floor(
          ((completed * 0.61803398875 + 0.13) % 1) * width,
        );
        let next, fence;
        try {
          const output = tf.tidy(() => {
            const jittered = rollDomeX(tf, image, shift);
            const engine = tf.engine(),
              ownsTape = engine.state.gradientDepth === 0;
            let result;
            try {
              result = tf.valueAndGrad((input) => {
                const act = model.execute(input, node);
                const target = act
                  .slice([0, 0, 0, channel], [-1, -1, -1, 1])
                  .mean();
                const dx = input
                  .sub(rollDomeX(tf, input, 1))
                  .square()
                  .mean();
                const dy = input
                  .slice([0, 1, 0, 0], [-1, height - 1, -1, -1])
                  .sub(input.slice([0, 0, 0, 0], [-1, height - 1, -1, -1]))
                  .square()
                  .mean();
                return target.sub(dx.add(dy).mul(0.02));
              })(jittered);
            } catch (error) {
              if (ownsTape && engine.state.gradientDepth === 0) {
                for (const entry of engine.state.activeTape || [])
                  tf.dispose(entry.saved);
                engine.state.activeTape = null;
              }
              throw error;
            }
            const unrolled = rollDomeX(tf, result.grad, -shift);
            const smooth = blurGradient(tf, unrolled);
            const normalized = smooth.div(
              tf.moments(smooth).variance.sqrt().add(1e-7),
            );
            const updated = applyDomeColorStep(
              tf,
              image,
              normalized,
              stepSize,
              colorRetention,
            );
            const next = constrainDomeColor(
              tf,
              project(tf, updated, base, c),
              base,
              colorRetention,
            );
            return { next, fence: tf.stack([result.value, next.mean()]) };
          });
          next = output.next;
          fence = output.fence;
          const values = await fence.data();
          if (!values.every(Number.isFinite))
            throw new Error("Dream synthesis produced non-finite pixels.");
          if (scoreStart === null) scoreStart = values[0];
          scoreEnd = values[0];
          image.dispose();
          image = next;
          next = null;
        } finally {
          next?.dispose();
          fence?.dispose();
        }
        completed++;
        onProgress(Math.round((completed / iterations) * 100));
        if (completed % 2 === 0) await tf.nextFrame();
      }
      base.dispose();
      base = null;
      tf.dispose(c);
      c = null;
    }
    signal?.throwIfAborted();
    // The last iteration already applies all constraints at full resolution.
    // Re-projecting here would attenuate the feathered gradient a second time.
    const pixels = image.squeeze([0]);
    try {
      const rgba = await tf.browser.toPixels(pixels);
      return {
        rgba,
        width: sourceWidth,
        height: sourceHeight,
        iterations: completed,
        scoreStart,
        scoreEnd,
        bakeMs: performance.now() - started,
        sizes,
      };
    } finally {
      pixels.dispose();
    }
  } finally {
    image?.dispose();
    base?.dispose();
    if (c) tf.dispose(c);
  }
}
