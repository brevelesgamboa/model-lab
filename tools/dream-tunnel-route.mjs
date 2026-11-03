// A bounded view onto a repeating Hilbert route. Global sites are deterministic;
// rendering rebases around the current site so coordinates never drift far away.
export const TUNNEL_SPACING = 18;
export const TUNNEL_LEVELS = Object.freeze([
  { name: "Photo clearing", start: 0 },
  { name: "Neon threshold", start: 1 },
  { name: "Woven passage", start: 2.8 },
  { name: "Signal drift", start: 5 },
  { name: "Folded gallery", start: 8 },
  { name: "Deep recurrence", start: 12 },
]);
const tunnelClamp = (x, a, b) => Math.max(a, Math.min(b, x));
export function tunnelSmooth(a, b, x) {
  const t = tunnelClamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
export function tunnelHash(index, seed = 417) {
  let x = (Math.imul(index | 0, 0x45d9f3b) ^ seed) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}
export function hilbertSite(index) {
  if (!Number.isSafeInteger(index) || index < 0)
    throw new RangeError("Route index must be a nonnegative safe integer.");
  const tile = Math.floor(index / 64);
  let d = index % 64,
    x = 0,
    y = 0;
  for (let scale = 1; scale < 8; scale *= 2) {
    const rx = 1 & (d >> 1),
      ry = 1 & (d ^ rx);
    if (ry === 0) {
      if (rx === 1) {
        x = scale - 1 - x;
        y = scale - 1 - y;
      }
      [x, y] = [y, x];
    }
    x += scale * rx;
    y += scale * ry;
    d >>= 2;
  }
  // Tile along -Z; the first passage heads along -X.
  return [-y, -(x + tile * 8)];
}
export function tunnelSite(index) {
  if (index < 0) return hilbertSite(1).map((v) => v * index * TUNNEL_SPACING);
  return hilbertSite(index).map((v) => v * TUNNEL_SPACING);
}
export function tunnelPath(parameter, originIndex = Math.floor(parameter)) {
  const i = Math.floor(parameter),
    t = parameter - i,
    origin = tunnelSite(originIndex);
  const points = [i - 1, i, i + 1, i + 2].map((n) =>
    tunnelSite(n).map((v, j) => v - origin[j]),
  );
  return [0, 1].map((j) => {
    const [a, b, c, d] = points.map((p) => p[j]);
    return (
      0.5 *
      (2 * b +
        (-a + c) * t +
        (2 * a - 5 * b + 4 * c - d) * t * t +
        (-a + 3 * b - 3 * c + d) * t * t * t)
    );
  });
}
export function tunnelFrame(parameter, originIndex = Math.floor(parameter)) {
  const p = tunnelPath(parameter, originIndex),
    a = tunnelPath(parameter - 0.002, originIndex),
    b = tunnelPath(parameter + 0.002, originIndex);
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]),
    forward = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
  return {
    position: p,
    forward,
    right: [-forward[1], forward[0]],
    yaw: Math.atan2(forward[0], -forward[1]),
  };
}
export function tunnelRadius(parameter) {
  return (
    2.2 +
    0.55 *
      (0.5 +
        0.5 * Math.cos((parameter - Math.floor(parameter)) * Math.PI * 2)) **
        5
  );
}
export function tunnelProfile(parameter) {
  const p = Math.max(0, parameter);
  let level = 0;
  for (let i = 0; i < TUNNEL_LEVELS.length; i++)
    if (p >= TUNNEL_LEVELS[i].start) level = i;
  return {
    level,
    name: TUNNEL_LEVELS[level].name,
    model: Math.min(6, p * 0.6),
    hex: tunnelSmooth(0.2, 3.5, p),
    neon: tunnelSmooth(0.15, 2.8, p),
    corruption: 0.82 * (1 - Math.exp(-Math.max(0, p - 4) / 8)),
    fractal: 0.58 * tunnelSmooth(7, 17, p),
    echo: tunnelSmooth(4, 10, p),
  };
}

export class DreamTunnelJourney {
  constructor({
    prepare = async () => null,
    onReady = () => {},
    seed = 417,
  } = {}) {
    this.prepare = prepare;
    this.onReady = onReady;
    this.seed = seed;
    this.parameter = 0;
    this.speed = 3;
    this.lateral = 0;
    this.elapsed = 0;
    this.epoch = 0;
    this.pending = null;
    this.prepared = -1;
    this.readyAt = -100;
    this.error = null;
    this.preparations = 0;
    this.readyTimes = new Map();
  }
  request(index) {
    if (this.pending?.index === index || this.readyTimes.has(index)) return;
    this.pending?.abort.abort();
    const abort = new AbortController(),
      epoch = this.epoch;
    const job = { index, abort };
    this.pending = job;
    this.error = null;
    this.preparations++;
    Promise.resolve()
      .then(() =>
        this.prepare({
          index,
          seed: tunnelHash(index, this.seed),
          profile: tunnelProfile(index),
          signal: abort.signal,
        }),
      )
      .then((result) => {
        if (
          this.pending !== job ||
          this.epoch !== epoch ||
          abort.signal.aborted
        )
          return;
        this.onReady(index, result);
        this.prepared = index;
        this.readyAt = this.elapsed;
        this.readyTimes.set(index, this.elapsed);
        while (this.readyTimes.size > 6)
          this.readyTimes.delete(this.readyTimes.keys().next().value);
        this.pending = null;
      })
      .catch((error) => {
        if (this.pending !== job || abort.signal.aborted) return;
        this.pending = null;
        this.error = error.message || String(error);
      });
  }
  update(seconds, forward = 0, strafe = 0) {
    if (![seconds, forward, strafe].every(Number.isFinite) || seconds < 0)
      throw new RangeError("Invalid movement.");
    const dt = Math.min(0.1, seconds);
    this.elapsed += dt;
    const node = Math.floor(this.parameter),
      fraction = this.parameter - node;
    if (
      fraction > 0.18 &&
      !this.readyTimes.has(node + 1) &&
      !this.pending &&
      !this.error
    )
      this.request(node + 1);
    let target = Math.max(
      0,
      this.parameter + (forward * this.speed * dt) / TUNNEL_SPACING,
    );
    if (
      forward > 0 &&
      target > node + 0.88 &&
      (!this.readyTimes.has(node + 1) ||
        this.elapsed - this.readyTimes.get(node + 1) < 0.65)
    )
      target = Math.max(this.parameter, node + 0.88);
    this.parameter = target;
    this.lateral = tunnelClamp(this.lateral + strafe * dt * 0.85, -0.7, 0.7);
    return this.snapshot();
  }
  snapshot() {
    const node = Math.floor(this.parameter),
      fraction = this.parameter - node,
      ready = this.readyTimes.has(node + 1),
      sinceReady =
        this.elapsed - (this.readyTimes.get(node + 1) ?? this.elapsed);
    const waiting = fraction >= 0.879 && !ready;
    const handoff =
      tunnelSmooth(0.52, 0.97, fraction) *
      (ready ? tunnelSmooth(0, 0.65, sinceReady) : 0);
    return {
      parameter: this.parameter,
      node,
      fraction,
      profile: tunnelProfile(this.parameter),
      lateral: this.lateral,
      waiting,
      pending: !!this.pending,
      error: this.error,
      warp:
        tunnelSmooth(0.73, 0.9, fraction) *
        (ready ? 1 - tunnelSmooth(0, 1.2, sinceReady) : 0.85),
      handoff,
      seed: this.seed,
    };
  }
  seek(parameter) {
    if (!Number.isFinite(parameter) || parameter < 0)
      throw new RangeError("Invalid route position.");
    this.cancel();
    this.parameter = parameter;
    this.prepared = -1;
    this.request(Math.floor(parameter) + 1);
  }
  cancel() {
    this.epoch++;
    this.pending?.abort.abort();
    this.pending = null;
    this.error = null;
    this.readyTimes.clear();
  }
  home() {
    this.cancel();
    this.parameter = 0;
    this.lateral = 0;
    this.prepared = -1;
    this.readyAt = -100;
  }
}
