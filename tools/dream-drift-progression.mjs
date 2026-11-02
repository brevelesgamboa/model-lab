// Experiment-only recipes and display lighting. No application defaults change.
const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const smooth = (a, b, n) => {
  const t = clamp((n - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export const PROGRESSION_RECIPES = Object.freeze(
  [
    { id: "arches", label: "Arches", organic: [0, 0, 0, 0, 0, 0] },
    { id: "organic", label: "Organic", organic: [1, 1, 1, 1, 1, 1] },
    {
      id: "mixed",
      label: "Arches → organic",
      organic: [0, 0, 1 / 3, 0.5, 0.75, 1],
    },
  ].map((recipe) =>
    Object.freeze({ ...recipe, organic: Object.freeze(recipe.organic) }),
  ),
);

export const PROGRESSION_LEVELS = Object.freeze(
  [
    {
      name: "Familiar",
      iterations: 2,
      stepSize: 0.004,
      protection: "photo",
      neon: 0.35,
    },
    {
      name: "Suggestive",
      iterations: 4,
      stepSize: 0.006,
      protection: "subject",
      neon: 0.45,
    },
    {
      name: "Unfolding",
      iterations: 6,
      stepSize: 0.008,
      protection: "subject",
      neon: 0.55,
    },
    {
      name: "Transformed",
      iterations: 6,
      stepSize: 0.01,
      protection: "subject",
      neon: 0.65,
    },
    {
      name: "Surreal",
      iterations: 8,
      stepSize: 0.012,
      protection: "subject",
      neon: 0.75,
    },
    {
      name: "Deep dream",
      iterations: 8,
      stepSize: 0.012,
      protection: "subject",
      neon: 0.8,
    },
  ].map(Object.freeze),
);

export function progressionStage(recipeId, level) {
  const recipe = PROGRESSION_RECIPES.find((r) => r.id === recipeId);
  if (
    !recipe ||
    !Number.isInteger(level) ||
    level < 1 ||
    level > PROGRESSION_LEVELS.length
  )
    throw new RangeError("Choose a progression recipe and level 1–6.");
  const settings = PROGRESSION_LEVELS[level - 1];
  const organicIterations = Math.round(
    settings.iterations * recipe.organic[level - 1],
  );
  const passes = [
    {
      target: "arches",
      layer: "mixed_6a",
      channel: 42,
      iterations: settings.iterations - organicIterations,
    },
    {
      target: "organic",
      layer: "mixed_6c",
      channel: 144,
      iterations: organicIterations,
    },
  ].filter((pass) => pass.iterations > 0);
  return { ...settings, level, recipe: recipe.id, passes };
}

// Hand-marked head centers for the three supplied test photos. These coordinates
// are fixture annotations, not automatic subject detection.
export function marmotSubjectRect(name, photoRect) {
  const marks = {
    "484351002_3898009110462736_2299646428952345762_n.jpg": [
      0.53, 0.23, 0.44, 0.24,
    ],
    "Himalayan-marmot_-udeyismailShutterstock-copy_en6jwc.jpg": [
      0.55, 0.425, 0.29, 0.19,
    ],
    "images.jpg": [0.53, 0.49, 0.38, 0.2],
  };
  const [cx, cy, w, h] = marks[name] || [0.5, 0.4, 0.3, 0.2];
  const width = Math.round(photoRect.width * w),
    height = Math.round(photoRect.height * h);
  return {
    x: Math.round(photoRect.x + photoRect.width * cx - width / 2),
    y: Math.round(photoRect.y + photoRect.height * cy - height / 2),
    width,
    height,
    feather: Math.max(2, Math.round(Math.min(width, height) * 0.25)),
  };
}

export function marmotViewPitch(name) {
  if (name === "484351002_3898009110462736_2299646428952345762_n.jpg")
    return 0.22;
  if (name === "Himalayan-marmot_-udeyismailShutterstock-copy_en6jwc.jpg")
    return 0.08;
  return 0;
}

function photoKeep(x, y, rect) {
  if (!rect) return 0;
  const d = Math.min(
    x - rect.x,
    rect.x + rect.width - 1 - x,
    y - rect.y,
    rect.y + rect.height - 1 - y,
  );
  return smooth(-rect.feather / 2, rect.feather / 2, d);
}

export function neonPanoramaPixels(
  rgba,
  reference,
  width,
  height,
  { strength = 0.65, photoRect = null } = {},
) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    rgba.length !== width * height * 4 ||
    reference.length !== rgba.length ||
    !Number.isFinite(strength) ||
    strength < 0 ||
    strength > 1
  )
    throw new RangeError(
      "Invalid neon panorama pixels, dimensions, or strength.",
    );
  if (strength === 0) return rgba.slice();
  const count = width * height;
  const light = new Float32Array(count),
    original = new Float32Array(count),
    emission = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const p = i * 4;
    light[i] =
      (rgba[p] * 0.2126 + rgba[p + 1] * 0.7152 + rgba[p + 2] * 0.0722) / 255;
    original[i] =
      (reference[p] * 0.2126 +
        reference[p + 1] * 0.7152 +
        reference[p + 2] * 0.0722) /
      255;
  }
  const at = (values, x, y) =>
    values[clamp(y, 0, height - 1) * width + ((x + width) % width)];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const dx = at(light, x + 1, y) - at(light, x - 1, y);
      const dy = at(light, x, y + 1) - at(light, x, y - 1);
      const rx = at(original, x + 1, y) - at(original, x - 1, y);
      const ry = at(original, x, y + 1) - at(original, x, y - 1);
      const novelEdges = Math.hypot(dx - rx, dy - ry);
      const changed = smooth(0.012, 0.18, Math.abs(light[i] - original[i]));
      emission[i] =
        smooth(0.012, 0.18, novelEdges) *
        changed *
        (1 - photoKeep(x, y, photoRect) * 0.7);
    }
  // Small separable bloom, periodic in longitude. It adds no new geometry,
  // spatial warps, channel splitting, random blocks, or generated details.
  let bloom = emission.slice();
  for (let pass = 0; pass < 3; pass++) {
    const horizontal = new Float32Array(count),
      next = new Float32Array(count);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        horizontal[i] =
          (at(bloom, x - 2, y) +
            2 * at(bloom, x - 1, y) +
            3 * bloom[i] +
            2 * at(bloom, x + 1, y) +
            at(bloom, x + 2, y)) /
          9;
      }
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        next[i] =
          (at(horizontal, x, y - 2) +
            2 * at(horizontal, x, y - 1) +
            3 * horizontal[i] +
            2 * at(horizontal, x, y + 1) +
            at(horizontal, x, y + 2)) /
          9;
      }
    bloom = next;
  }
  const output = rgba.slice();
  const violet = [0.59, 0.31, 1],
    cyan = [0.04, 0.94, 1];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        p = i * 4,
        luma = light[i];
      const amount = strength * (1 - photoKeep(x, y, photoRect) * 0.85);
      const hue = smooth(0.08, 0.68, luma);
      const tint = amount * (0.1 + Math.pow(1 - luma, 2) * 0.5);
      const glow = Math.min(
        0.75,
        amount * (emission[i] * 0.45 + bloom[i] * 1.4),
      );
      for (let c = 0; c < 3; c++) {
        const accent = violet[c] * (1 - hue) + cyan[c] * hue;
        let value = rgba[p + c] / 255;
        value = value * (1 - tint) + accent * Math.max(0.4, luma + 0.06) * tint;
        output[p + c] = Math.round(
          255 * (1 - (1 - value) * (1 - accent * glow)),
        );
      }
    }
  return output;
}
