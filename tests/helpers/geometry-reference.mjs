// Independent double-precision oracle for the shared GLSL field. Browser tests
// compare these samples with actual GPU output; no CPU field runs in the app.
const PI = Math.PI,
  TAU = 2 * PI;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mix = (a, b, t) => a + (b - a) * t;
const mod = (x, period) => ((x % period) + period) % period;
const smooth = (lo, hi, x) => {
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};
export const angleDistance = (a, b) => Math.abs(mod(a - b + PI, TAU) - PI);
export const circularMix = (a, b, t) =>
  a + clamp(t, 0, 1) * (mod(b - a + PI, TAU) - PI);
const angle = ([x, y], fallback = 0) =>
  Number.isFinite(x) && Number.isFinite(y) && x * x + y * y >= 1e-12
    ? Math.atan2(y, x)
    : fallback;
export const spiralSlope = (pitch) => {
  const t = Math.tan(clamp(pitch, (-89 * PI) / 180, (89 * PI) / 180));
  return t / Math.hypot(1, t / 8);
};
export const secondSpin = (twist) =>
  (2 * smooth(-0.35, 0, twist) - 1) * Math.max(0.2, 1 - Math.abs(twist) * 0.45);
export function voronoiNeighbors([x, y], softness = 0.25) {
  const scale = mix(2.2, 4.2, softness),
    gx = x * scale,
    gy = y * scale;
  const sites = [];
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const sx = Math.floor(gx) + i,
        sy = Math.floor(gy) + j;
      const diff = [
        sx + 0.5 + 0.38 * Math.sin(sx * 127.1 + sy * 311.7) - gx,
        sy + 0.5 + 0.38 * Math.sin(sx * 269.5 + sy * 183.3) - gy,
      ];
      sites.push({ id: `${sx},${sy}`, diff, dist: Math.hypot(...diff) });
    }
  return sites.sort((a, b) => a.dist - b.dist);
}
export function geometryAngle(
  pos,
  {
    mode = 0,
    base = 0,
    twist = 0,
    strength = 1,
    softness = 0.25,
    size = 256,
    folds = 6,
  } = {},
) {
  if (!mode || strength <= 0) return base;
  const [x, y] = pos,
    r = Math.hypot(x, y),
    phi = angle(pos);
  const core = Math.max(4 / size, mix(0.025, 0.3, softness));
  let theta = base,
    influence = [1, 2, 6, 7].includes(mode) ? smooth(0, core, r) : 1;
  if (mode === 1) theta = phi + PI / 2 + twist + base;
  if (mode === 2) {
    const slope = spiralSlope(twist),
      sc = Math.max(core, (Math.abs(slope) * 2) / (size * 0.65));
    influence = smooth(0, sc, r);
    theta = phi + PI / 2 + Math.log(Math.hypot(r, sc)) * slope + base;
  }
  if (mode === 3) {
    let a = x * 1.25,
      b = y * 1.25;
    for (let i = 0; i < 5; i++)
      [a, b] = [a * a - b * b - 0.8, 2 * a * b + 0.156];
    theta = angle([a, b], -twist) + twist + base;
    influence = smooth(0, 0.15, Math.hypot(a, b));
  }
  if (mode === 4 || mode === 8) {
    const spacing =
      mode === 4 ? 0.45 : mix(0.25, 0.65, clamp(softness * 1.5, 0, 1));
    const a = x + spacing,
      b = x - spacing,
      d1 = a * a + y * y + 0.01 + softness * 0.15,
      d2 = b * b + y * y + 0.01 + softness * 0.15;
    const spin = mode === 4 ? -1 : secondSpin(twist),
      turn = mode === 4 ? twist : 0;
    const flow = [-y / d1 - (spin * y) / d2, a / d1 + (spin * b) / d2];
    theta = angle(flow, -turn) + turn + base;
    influence = smooth(0, 0.15, Math.hypot(...flow));
  }
  if (mode === 5)
    theta =
      base +
      Math.sin(y * TAU + x * Math.sin(twist) * PI + base) *
        (0.85 + Math.abs(twist) * 0.5) +
      twist;
  if (mode === 6) theta = angle([x, -y]) + twist + base;
  if (mode === 7) {
    const sector = TAU / folds,
      folded = Math.abs(mod(phi + sector * 0.5, sector) - sector * 0.5);
    theta = phi + folded * 2 + PI / 2 + twist + base;
  }
  if (mode === 9) {
    const [a, b] = voronoiNeighbors(pos, softness);
    let [nx, ny] = [b.diff[0] - a.diff[0], b.diff[1] - a.diff[1]];
    if (nx < 0 || (nx === 0 && ny < 0)) [nx, ny] = [-nx, -ny];
    const wall = angle([-ny, nx]),
      island = angle(a.diff, wall - PI / 2) + PI / 2;
    const width =
      mix(0.35, 0.6, softness) * (1 - clamp(twist * 0.8, -0.6, 0.6));
    const weight = 1 - smooth(0.02, width, Math.max(0, b.dist - a.dist));
    theta =
      circularMix(island, wall, weight) +
      (clamp(twist * 0.7, -1, 1) * PI) / 2 +
      base;
  }
  return circularMix(
    base,
    theta,
    strength * mix(1, 1 - smooth(0.4, 1.3, r), softness) * influence,
  );
}

export function juliaZero() {
  let x = 0,
    y = 0;
  for (let i = 0; i < 5; i++) {
    const a = x + 0.8,
      b = y - 0.156,
      radius = Math.hypot(a, b);
    x = Math.sqrt((radius + a) / 2);
    y = Math.sign(b) * Math.sqrt((radius - a) / 2);
  }
  return [x / 1.25, y / 1.25];
}

// Origins, antipodal half-strength, spiral pitches, stagnation and mirror seams.
export function geometrySamples() {
  const samples = [];
  for (let mode = 0; mode <= 9; mode++)
    for (const pos of [
      [0, 0],
      [1e-7, -1e-7],
      [0.3, 0.4],
      [-0.6, 0.2],
      [1.4, -1.7],
    ]) {
      for (const strength of [0, 0.5, 1])
        samples.push({
          pos,
          options: { mode, strength, base: 0.23, twist: 0.31 },
        });
    }
  for (const twist of [
    -Math.PI / 2,
    (-89 * PI) / 180,
    (89 * PI) / 180,
    Math.PI / 2,
  ])
    for (const softness of [0, 1]) {
      samples.push({
        pos: [0.02, 0.003],
        options: { mode: 2, twist, softness },
      });
    }
  for (const twist of [-0.01001, -0.01, -0.00999, -0.35, -0.175, 0, 0.35])
    samples.push({ pos: [0.2, 0.4], options: { mode: 8, twist } });
  for (const folds of [3, 6, 12])
    for (let i = -folds; i <= folds; i++)
      for (const offset of [-1e-5, 1e-5]) {
        const phi = (i * PI) / folds + offset;
        samples.push({
          pos: [0.7 * Math.cos(phi), 0.7 * Math.sin(phi)],
          options: { mode: 7, folds },
        });
      }
  const dipoleStagnation = Math.sqrt(0.45 ** 2 + 0.01 + 0.25 * 0.15);
  for (const [mode, root] of [
    [8, 0],
    [4, dipoleStagnation],
    [4, -dipoleStagnation],
  ]) {
    for (const offset of [-1e-7, 0, 1e-7]) {
      samples.push({ pos: [root + offset, 0], options: { mode, base: 0.4 } });
    }
  }
  samples.push({
    pos: juliaZero(),
    options: { mode: 3, base: 0.4, twist: 0.2 },
  });
  for (const mode of [1, 2, 6, 7])
    for (const softness of [0, 0.25, 1])
      for (const pos of [
        [0, 0],
        [1e-7, 0],
        [-1e-7, 0],
        [0, 1e-7],
        [0, -1e-7],
      ]) {
        samples.push({ pos, options: { mode, softness, base: 0.7 } });
      }
  // A known shared Voronoi wall, approached from either nearest-site ordering.
  const a = [0.5, 0.5],
    b = [1.5 + 0.38 * Math.sin(127.1), 0.5 + 0.38 * Math.sin(269.5)];
  for (const softness of [0, 0.25, 1])
    for (const twist of [-Math.PI / 2, 0, Math.PI / 2])
      for (const strength of [0.5, 1])
        for (const side of [-1, 1]) {
          const scale = 2.2 + 2 * softness;
          const pos = [
            (a[0] + b[0]) / (2 * scale) + side * (b[0] - a[0]) * 1e-5,
            (a[1] + b[1]) / (2 * scale) + side * (b[1] - a[1]) * 1e-5,
          ];
          samples.push({
            pos,
            options: { mode: 9, softness, twist, strength },
          });
        }
  return samples.map((s) => ({
    ...s,
    expected: geometryAngle(s.pos, s.options),
  }));
}
