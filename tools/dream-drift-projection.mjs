// Experimental texture-space approach motion. A virtual observer advances
// inside a unit sphere; the actual dome camera stays at the origin. Rays are
// intersected with that sphere to sample the prior panoramic texture directly.
const TAU = Math.PI * 2;
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

function validateAdvance(advance) {
  if (!Number.isFinite(advance) || advance < 0 || advance > 0.25)
    throw new RangeError("Advance must be between 0 and 0.25 sphere radii.");
}

export function advanceDirection(direction, advance) {
  validateAdvance(advance);
  if (direction.length !== 3 || !direction.every(Number.isFinite))
    throw new RangeError("A finite three-dimensional direction is required.");
  const magnitude = Math.hypot(...direction);
  if (magnitude < 1e-12) throw new RangeError("Direction cannot be zero.");
  const [x, y, z] = direction.map((value) => value / magnitude);
  const dot = -advance * z;
  const distance = -dot + Math.sqrt(dot * dot + 1 - advance * advance);
  return [distance * x, distance * y, -advance + distance * z];
}

export function advancePanoramaPixels(rgba, width, height, advance = 0.08) {
  validateAdvance(advance);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    height < 2 ||
    width !== height * 2
  )
    throw new RangeError("A 2:1 panoramic image is required.");
  if (
    !ArrayBuffer.isView(rgba) ||
    rgba.BYTES_PER_ELEMENT !== 1 ||
    rgba.length !== width * height * 4
  )
    throw new RangeError("Expected RGBA bytes for the whole panorama.");
  if (advance === 0) return new Uint8ClampedArray(rgba);
  const result = new Uint8ClampedArray(rgba.length);
  const sine = new Float64Array(width),
    cosine = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    const longitude = ((x + 0.5) / width - 0.5) * TAU;
    sine[x] = Math.sin(longitude);
    cosine[x] = Math.cos(longitude);
  }
  for (let y = 0; y < height; y++) {
    const latitude = (0.5 - (y + 0.5) / height) * Math.PI;
    const ring = Math.cos(latitude),
      vertical = Math.sin(latitude);
    for (let x = 0; x < width; x++) {
      const dx = sine[x] * ring,
        dz = -cosine[x] * ring;
      const dot = -advance * dz;
      const distance = -dot + Math.sqrt(dot * dot + 1 - advance * advance);
      const px = distance * dx,
        py = distance * vertical,
        pz = -advance + distance * dz;
      const sourceX = (Math.atan2(px, -pz) / TAU + 0.5) * width - 0.5;
      const sourceY = clamp(
        (0.5 - Math.asin(clamp(py, -1, 1)) / Math.PI) * height - 0.5,
        0,
        height - 1,
      );
      const left = Math.floor(sourceX),
        top = Math.floor(sourceY);
      const x0 = ((left % width) + width) % width,
        x1 = (x0 + 1) % width;
      const y1 = Math.min(height - 1, top + 1),
        fx = sourceX - left,
        fy = sourceY - top;
      const a = (top * width + x0) * 4,
        b = (top * width + x1) * 4;
      const c = (y1 * width + x0) * 4,
        d = (y1 * width + x1) * 4;
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel++)
        result[offset + channel] =
          (rgba[a + channel] * (1 - fx) + rgba[b + channel] * fx) * (1 - fy) +
          (rgba[c + channel] * (1 - fx) + rgba[d + channel] * fx) * fy;
    }
  }
  return result;
}
