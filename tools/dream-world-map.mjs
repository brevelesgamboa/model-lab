// First exploration slice. Stable places share the approved original dome look.
// Map coordinates describe the fold network; each place has an open local floor.
export const WORLD_VERSION = "dream-world-v1";
export const WORLD_AREAS = Object.freeze(
  [
    {
      id: "clearing",
      name: "Photo Clearing",
      depth: 0,
      site: [0, 0],
      landmark: [0, -3, 0],
      study: 0,
      description: "Two paths unfold from the familiar image.",
    },
    {
      id: "waves",
      name: "Wave Fields",
      depth: 1,
      site: [-36, -36],
      landmark: [-3, -2, 1],
      study: 1,
      description: "A standing ripple marks the quieter route into the folds.",
    },
    {
      id: "garden",
      name: "Echo Gardens",
      depth: 2,
      site: [42, -42],
      landmark: [3, -2, 2],
      study: 1,
      pass: { layer: "mixed_6c", channel: 144, iterations: 8, stepSize: 0.022 },
      description:
        "An orbiting bloom hides a second ripple beyond the obvious exit.",
    },
    {
      id: "terrace",
      name: "Return Terrace",
      depth: 1.4,
      site: [-42, -90],
      landmark: [0, 2, 4],
      study: 1,
      pass: {
        layer: "Conv2d_4a_3x3",
        channel: 42,
        iterations: 6,
        stepSize: 0.018,
      },
      description:
        "A low spiral remembers the way back. Its shortcut responds to the deep signal.",
    },
    {
      id: "hex",
      name: "Hex Expanse",
      depth: 3,
      site: [0, -126],
      landmark: [0, -3, 3],
      study: 2,
      description:
        "The image becomes full colored hex. The paths behind you remain open.",
    },
    {
      id: "pocket",
      name: "Hidden Resonance",
      depth: 2.6,
      site: [78, -102],
      landmark: [0, -2, 5],
      study: 2,
      pass: { layer: "mixed_6d", channel: 182, iterations: 8, stepSize: 0.024 },
      hidden: true,
      description:
        "A small echo outside the main loop, with another opening toward the depths.",
    },
  ].map((a) =>
    Object.freeze({
      ...a,
      site: Object.freeze(a.site),
      landmark: Object.freeze(a.landmark),
      ...(a.pass ? { pass: Object.freeze(a.pass) } : {}),
    }),
  ),
);
const edges = [
  { a: "clearing", b: "waves" },
  { a: "clearing", b: "garden" },
  { a: "waves", b: "terrace" },
  { a: "terrace", b: "hex" },
  { a: "garden", b: "hex" },
  { a: "terrace", b: "clearing", shortcut: true },
  { a: "garden", b: "pocket", hidden: true },
  { a: "pocket", b: "hex", hidden: true },
];
export const WORLD_EDGES = Object.freeze(edges.map(Object.freeze));
const areaById = new Map(WORLD_AREAS.map((a) => [a.id, a]));
export function worldArea(id) {
  const a = areaById.get(id);
  if (!a) throw new RangeError("Unknown dream place.");
  return a;
}
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export function worldAppearance(depth) {
  return {
    neon: smooth(0, 3, depth) * 0.35,
    hex: smooth(0, 3, depth),
    corruption: smooth(0, 3, depth) * 0.72,
  };
}
export function worldGates(id) {
  const area = worldArea(id);
  return WORLD_EDGES.filter((e) => e.a === id || e.b === id).map((edge) => {
    const target = worldArea(edge.a === id ? edge.b : edge.a),
      dx = target.site[0] - area.site[0],
      dz = target.site[1] - area.site[1],
      length = Math.hypot(dx, dz),
      direction = [dx / length, dz / length];
    return {
      ...edge,
      id: `${id}:${target.id}`,
      target: target.id,
      position: direction.map((v) => v * 12),
      yaw: Math.atan2(direction[0], -direction[1]),
      direction,
    };
  });
}
export class DreamWorldMap {
  constructor(seed = 417) {
    this.seed = seed >>> 0;
    this.current = "clearing";
    this.visited = new Set(["clearing"]);
    this.discovered = new Set(["clearing"]);
    this.floorOffset = [0, 0];
    this.floorPhases = { clearing: [0, 0] };
    this.discoverNeighbors();
  }
  get area() {
    return worldArea(this.current);
  }
  get shortcutOpen() {
    return this.visited.has("hex");
  }
  available(gate) {
    return (
      (!gate.shortcut || this.shortcutOpen) &&
      (!gate.hidden || this.discovered.has("pocket"))
    );
  }
  discoverNeighbors() {
    for (const gate of worldGates(this.current))
      if (!gate.hidden && (!gate.shortcut || this.shortcutOpen))
        this.discovered.add(gate.target);
  }
  discoverAt(position) {
    let changed = false;
    for (const g of worldGates(this.current))
      if (
        g.hidden &&
        Math.hypot(position[0] - g.position[0], position[1] - g.position[1]) <
          5.2
      ) {
        if (!this.discovered.has("pocket")) {
          this.discovered.add("pocket");
          changed = true;
        }
      }
    return changed;
  }
  gates(position = [0, 0]) {
    return worldGates(this.current).map((g) => ({
      ...g,
      open: this.available(g),
      known: !g.hidden || this.discovered.has("pocket"),
      distance: Math.hypot(
        position[0] - g.position[0],
        position[1] - g.position[1],
      ),
    }));
  }
  nearest(position) {
    return (
      this.gates(position)
        .filter((g) => g.open)
        .sort((a, b) => a.distance - b.distance)[0] || null
    );
  }
  crossed(before, after) {
    return (
      this.gates(after).find((g) => {
        if (!g.open) return false;
        const a =
            (before[0] - g.position[0]) * g.direction[0] +
            (before[1] - g.position[1]) * g.direction[1],
          b =
            (after[0] - g.position[0]) * g.direction[0] +
            (after[1] - g.position[1]) * g.direction[1];
        const side =
          (after[0] - g.position[0]) * -g.direction[1] +
          (after[1] - g.position[1]) * g.direction[0];
        return a < 0 && b >= 0 && Math.abs(side) < 1.65;
      }) || null
    );
  }
  arrival(target) {
    const gate = worldGates(target).find((g) => g.target === this.current);
    if (!gate) throw new RangeError("Places are not connected.");
    return gate.position.map((v, i) => v - gate.direction[i] * 2.4);
  }
  arrivalFloor(target, position) {
    const arrival = this.arrival(target);
    return (
      this.floorPhases[target] ||
      this.floorOffset.map(
        (v, i) => (((v + position[i] - arrival[i]) % 3) + 3) % 3,
      )
    );
  }
  floorShift(target, position) {
    const arrival = this.arrival(target),
      offset = this.arrivalFloor(target, position);
    return offset.map(
      (v, i) =>
        ((((arrival[i] + v - position[i] - this.floorOffset[i] + 1.5) % 3) +
          3) %
          3) -
        1.5,
    );
  }
  commit(target, previousPosition) {
    const gate = this.gates(previousPosition).find(
      (g) => g.target === target && g.open,
    );
    if (!gate) throw new RangeError("This fold is not available.");
    const arrival = this.arrival(target);
    this.floorOffset = [...this.arrivalFloor(target, previousPosition)];
    this.floorPhases[target] = [...this.floorOffset];
    this.current = target;
    this.visited.add(target);
    this.discovered.add(target);
    this.discoverNeighbors();
    return arrival;
  }
  home() {
    this.floorOffset = [...this.floorPhases.clearing];
    this.current = "clearing";
    this.visited.add("clearing");
    this.discoverNeighbors();
    return [0, 0];
  }
  serialize(position = [0, 0], yaw = 0, pitch = 0) {
    return {
      version: WORLD_VERSION,
      seed: this.seed,
      current: this.current,
      visited: [...this.visited],
      discovered: [...this.discovered],
      position: [...position],
      yaw,
      pitch,
      floorOffset: [...this.floorOffset],
      floorPhases: structuredClone(this.floorPhases),
    };
  }
  restore(value) {
    const vector = (v) =>
      Array.isArray(v) &&
      v.length === 2 &&
      v.every((n) => Number.isFinite(n) && Math.abs(n) < 1e6);
    if (
      !value ||
      value.version !== WORLD_VERSION ||
      value.seed !== this.seed ||
      !areaById.has(value.current) ||
      !vector(value.position) ||
      !vector(value.floorOffset) ||
      !Number.isFinite(value.yaw) ||
      !Number.isFinite(value.pitch) ||
      !Array.isArray(value.visited) ||
      !Array.isArray(value.discovered)
    )
      return null;
    if (
      [...value.visited, ...value.discovered].some((id) => !areaById.has(id)) ||
      !value.visited.includes(value.current)
    )
      return null;
    const phases = value.floorPhases;
    if (
      !phases ||
      Object.keys(phases).some(
        (id) => !areaById.has(id) || !vector(phases[id]),
      ) ||
      !vector(phases.clearing) ||
      !vector(phases[value.current])
    )
      return null;
    this.current = value.current;
    this.visited = new Set(value.visited);
    this.visited.add("clearing");
    this.discovered = new Set([...value.discovered, ...this.visited]);
    this.floorOffset = [...phases[value.current]];
    this.floorPhases = structuredClone(phases);
    this.discoverNeighbors();
    return {
      position: [...value.position],
      yaw: value.yaw,
      pitch: Math.max(-1.35, Math.min(1.35, value.pitch)),
    };
  }
}
