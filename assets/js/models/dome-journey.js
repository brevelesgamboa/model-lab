import {
  DREAM_CELL_SIZE,
  dreamCellHash,
  dreamWarp,
  dreamUnwarp,
  dreamBridge,
  getRoomTypology,
  DREAM_ROOM_TYPES,
} from "./dome-journey-layout.js";

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const smooth = (a, b, n) => {
  const t = clamp((n - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// Four cached photo treatments are distributed across the seeded space.
export const DREAM_REGIONS = Object.freeze(
  [
    { id: "photo", name: "Photo clearing", center: [0, 0] },
    {
      id: "arches",
      name: "Recursive folds",
      center: [0, -20],
      shift: [-64, 0],
    },
    { id: "lattice", name: "Filigree", center: [20, -20], shift: [64, 0] },
    { id: "ribbons", name: "Echo chambers", center: [20, 0], shift: [0, -32] },
    { id: "cavern", name: "Corrupted blooms", center: [0, 20], shift: [0, 32] },
  ].map((r) =>
    Object.freeze({
      ...r,
      center: Object.freeze(r.center),
      ...(r.shift ? { shift: Object.freeze(r.shift) } : {}),
    }),
  ),
);

// Coordinated local moods; seeded variations stay fixed on revisits.
export const DREAM_AREA_PRESETS = Object.freeze(
  DREAM_ROOM_TYPES.map(({ name, recursion, corruption, density }) =>
    Object.freeze({ name, recursion, corruption, density }),
  ),
);
const STYLE_NEUTRAL = { recursion: 0.72, corruption: 0.64, density: 0.65 };

export class DomeJourney {
  constructor(seed = Math.floor(Math.random() * 0xffffffff)) {
    this.seed = seed >>> 0;
    this.historyEpoch = 0;
    this.enabled = false;
    this.position = [0, 0];
    this.speed = 2;
    this.faithfulness = 0.75;
    this.retro = 0.18;
    this.recursion = 0.28;
    this.corruption = 0.08;
    this.density = 0.35;
    this.clarity = 0.85;
    this.neuralDetail = false;
    this.depthParallax = 0.5;
    this.depthFog = 0.25;
    this.depthContours = 0.12;
    this.warp = null;
    this.lastWarpProgress = 0;
    this.radarTime = 0;
    this.discovered = new Map();
    this.visited = new Set();
    this.breadcrumbs = [];
    this.rememberPosition({ force: true });
  }
  get distance() {
    return Math.hypot(...this.position);
  }
  get region() {
    if (this.distance < 1) return DREAM_REGIONS[0];
    const weights = this.regionWeights;
    return DREAM_REGIONS[1 + weights.indexOf(Math.max(...weights))];
  }
  newDream(seed = (this.seed + 0x9e3779b9) >>> 0) {
    this.seed = seed >>> 0;
    this.home();
    this.resetExploration();
  }
  get generationRegions() {
    const rotation = this.seed % 4;
    return DREAM_REGIONS.slice(1).map((r, i) => ({
      ...r,
      shift: DREAM_REGIONS[1 + ((i + rotation) % 4)].shift,
    }));
  }
  get section() {
    if (this.distance < 1) return DREAM_REGIONS[0].name;
    const cell = dreamWarp(this.position, this.seed).map((v) =>
      Math.round(v / DREAM_CELL_SIZE),
    );
    return getRoomTypology(...cell, this.seed).name;
  }
  home() {
    this.cancelWarp();
    this.onReturnToPhoto?.();
    this.lastWarpProgress = 0;
    this.position = [0, 0];
    this.rememberPosition({ force: true, breakTrace: true });
    this.historyEpoch++;
  }
  visit(id) {
    const region = DREAM_REGIONS.find((r) => r.id === id);
    if (!region) throw new RangeError("Unknown dream region.");
    if (id === "photo") {
      this.home();
      return;
    }
    this.cancelWarp();
    const motif = DREAM_REGIONS.indexOf(region) - 1;
    for (let z = -1; z >= -24; z--)
      for (let x = -2; x <= 2; x++)
        if (dreamCellHash(x, z, this.seed) % 4 === motif) {
          this.position = dreamUnwarp(
            [x * DREAM_CELL_SIZE, z * DREAM_CELL_SIZE],
            this.seed,
          );
          this.historyEpoch++;
          this.rememberPosition({ force: true, breakTrace: true });
          return;
        }
  }
  move(forward, right, seconds, yaw) {
    if (
      !this.enabled ||
      this.warping ||
      ![forward, right, seconds, yaw].every(Number.isFinite) ||
      seconds <= 0
    )
      return false;
    const input = Math.hypot(forward, right);
    if (!input) return false;
    if (!this.breadcrumbs.length) this.rememberPosition({ force: true });
    const step = (Math.min(seconds, 0.25) * this.speed) / Math.max(1, input);
    this.position[0] +=
      (Math.sin(yaw) * forward + Math.cos(yaw) * right) * step;
    this.position[1] +=
      (-Math.cos(yaw) * forward + Math.sin(yaw) * right) * step;
    if (this.distance < 1e-9) this.position = [0, 0];
    this.rememberPosition();
    return true;
  }
  get warping() {
    return this.warp !== null;
  }
  get warpProgress() {
    return this.warp?.progress ?? this.lastWarpProgress;
  }
  get warpUniform() {
    if (!this.warp) return [0, 0, 0, 0];
    const t = this.warp.progress;
    return [1, t, this.warp.elapsed, 16 * t * t * (1 - t) * (1 - t)];
  }
  startWarp(id) {
    const node = this.discovered.get(id);
    if (
      !this.enabled ||
      this.warping ||
      !node ||
      ![...this.position, ...node.position].every(Number.isFinite) ||
      Math.hypot(
        node.position[0] - this.position[0],
        node.position[1] - this.position[1],
      ) < 0.05
    )
      return false;
    this.warp = {
      id,
      from: [...this.position],
      to: [...node.position],
      elapsed: 0,
      progress: 0,
    };
    this.lastWarpProgress = 0;
    this.historyEpoch++;
    this.onWarpStart?.(node, this.warp);
    return true;
  }
  advanceWarp(seconds) {
    if (!this.warp || !Number.isFinite(seconds) || seconds <= 0) return false;
    if (!this.enabled) return this.cancelWarp();
    const warp = this.warp;
    warp.elapsed = Math.min(5, warp.elapsed + seconds);
    if (warp.elapsed > 5 - 1e-9) warp.elapsed = 5;
    warp.progress = warp.elapsed / 5;
    const t = warp.progress,
      eased = t * t * t * (10 + t * (-15 + 6 * t));
    this.position = warp.from.map((v, i) => v + (warp.to[i] - v) * eased);
    this.lastWarpProgress = t;
    this.rememberPosition({ discover: t === 1 });
    if (t === 1) {
      this.position = [...warp.to];
      this.warp = null;
      this.historyEpoch++;
      this.onWarpComplete?.(warp);
    }
    return true;
  }
  cancelWarp() {
    if (!this.warp) return false;
    const warp = this.warp;
    this.warp = null;
    this.lastWarpProgress = 0;
    this.historyEpoch++;
    this.rememberPosition({ force: true });
    this.onWarpCancel?.(warp);
    return true;
  }
  resetExploration() {
    this.discovered.clear();
    this.visited.clear();
    this.breadcrumbs = [];
    this.rememberPosition({ force: true, breakTrace: true });
  }
  setRadarTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < this.radarTime) return;
    this.radarTime = seconds;
    this.breadcrumbs = this.breadcrumbs.filter((p) => seconds - p.time < 24);
  }
  rememberPosition({
    force = false,
    discover = true,
    breakTrace = false,
  } = {}) {
    const last = this.breadcrumbs.at(-1);
    if (
      force ||
      !last ||
      Math.hypot(
        last.position[0] - this.position[0],
        last.position[1] - this.position[1],
      ) >= 0.12
    ) {
      this.breadcrumbs.push({
        position: [...this.position],
        time: this.radarTime,
        break: breakTrace,
      });
      if (this.breadcrumbs.length > 256) this.breadcrumbs.shift();
    }
    if (!discover) return;
    const [x, z] = dreamWarp(this.position, this.seed).map((v) =>
      Math.round(v / DREAM_CELL_SIZE),
    );
    this.visited.add(`${x},${z}`);
    const cells = [
      [x, z],
      [x, z - 1],
      [x, z + 1],
    ];
    if (dreamBridge(x, z, this.seed)) cells.push([x + 1, z]);
    if (dreamBridge(x - 1, z, this.seed)) cells.push([x - 1, z]);
    for (const [cx, cz] of cells) {
      const id = `${cx},${cz}`;
      if (!this.discovered.has(id))
        this.discovered.set(id, {
          id,
          cell: [cx, cz],
          position: dreamUnwarp(
            [cx * DREAM_CELL_SIZE, cz * DREAM_CELL_SIZE],
            this.seed,
          ),
          motif: dreamCellHash(cx, cz, this.seed) % 4,
          typology: getRoomTypology(cx, cz, this.seed),
        });
    }
  }
  get regionWeights() {
    const p = dreamWarp(this.position, this.seed).map(
      (v) => v / DREAM_CELL_SIZE,
    );
    const cell = p.map(Math.floor),
      t = p.map((v, i) => smooth(0, 1, v - cell[i]));
    const weights = [0, 0, 0, 0];
    for (let z = 0; z <= 1; z++)
      for (let x = 0; x <= 1; x++)
        weights[dreamCellHash(cell[0] + x, cell[1] + z, this.seed) % 4] +=
          (x ? t[0] : 1 - t[0]) * (z ? t[1] : 1 - t[1]);
    return weights;
  }
  get sourceWeight() {
    return (
      1 - smooth(1, 8, this.distance) * (1 - clamp(this.faithfulness, 0.4, 1))
    );
  }
  get weights() {
    return this.regionWeights.map((v) => v * (1 - this.sourceWeight));
  }
  get entrance() {
    return {
      relief: smooth(0, 1.5, this.distance),
      aperture: smooth(1.5, 4, this.distance),
    };
  }
  get geometry() {
    return this.entrance.aperture;
  }
  get areaPreset() {
    const p = dreamWarp(this.position, this.seed).map(
      (v) => v / DREAM_CELL_SIZE,
    );
    const cell = p.map(Math.floor),
      t = p.map((v, i) => smooth(0, 1, v - cell[i]));
    const result = { recursion: 0, corruption: 0, density: 0 };
    for (let z = 0; z <= 1; z++)
      for (let x = 0; x <= 1; x++) {
        const hash = dreamCellHash(cell[0] + x, cell[1] + z, this.seed);
        const preset = getRoomTypology(cell[0] + x, cell[1] + z, this.seed);
        const weight = (x ? t[0] : 1 - t[0]) * (z ? t[1] : 1 - t[1]);
        const variation = 0.9 + (((hash >>> 8) % 1024) / 1023) * 0.2;
        for (const key of Object.keys(result))
          result[key] += clamp(preset[key] * variation, 0, 1) * weight;
      }
    return result;
  }
  get style() {
    const preset = this.areaPreset;
    return ["recursion", "corruption", "density"]
      .map((key) => {
        const value = clamp(this[key], 0, 1),
          base = STYLE_NEUTRAL[key];
        // Keep the original neutral calibration so calmer launch settings
        // attenuate automatic area variation while zero/max overrides still work.
        return value <= base
          ? (preset[key] * value) / base
          : preset[key] + ((1 - preset[key]) * (value - base)) / (1 - base);
      })
      .concat(clamp(this.clarity, 0, 1));
  }
  offset(cameraPosition = [0, 0, 0]) {
    const warped = dreamWarp(this.position, this.seed);
    const offset = [
      Math.sin((warped[0] / DREAM_CELL_SIZE) * Math.PI) * 0.22 +
        cameraPosition[0] / 5,
      cameraPosition[1] / 5,
      Math.sin((warped[1] / DREAM_CELL_SIZE) * Math.PI) * 0.22 +
        cameraPosition[2] / 5,
    ];
    const length = Math.hypot(...offset);
    return length > 0.85 ? offset.map((v) => (v / length) * 0.85) : offset;
  }
}

export function journeyDirection(direction, offset) {
  if (
    direction.length !== 3 ||
    offset.length !== 3 ||
    ![...direction, ...offset].every(Number.isFinite) ||
    Math.hypot(...offset) >= 1 ||
    !Math.hypot(...direction)
  )
    throw new RangeError(
      "Expected a finite ray and an offset inside the unit sphere.",
    );
  const ray = direction.map((v) => v / Math.hypot(...direction));
  const projection = ray.reduce((sum, v, i) => sum + v * offset[i], 0);
  const distance =
    -projection +
    Math.sqrt(
      projection * projection + 1 - offset.reduce((sum, v) => sum + v * v, 0),
    );
  return ray.map((v, i) => offset[i] + v * distance);
}
