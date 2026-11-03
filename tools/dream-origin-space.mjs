// Exploration is an image-space illusion. The floor and optional fold use free
// world coordinates; the original dome keeps a small, bounded parallax offset.
const originClamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const originSmooth = (x) => {
  const t = originClamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};
export const ORIGIN_STUDIES = Object.freeze([
  { name: "Original", passes: [] },
  {
    name: "Light",
    passes: [
      { layer: "mixed_6a", channel: 42, iterations: 6, stepSize: 0.014 },
    ],
  },
  {
    name: "Deep",
    passes: [
      { layer: "mixed_6a", channel: 42, iterations: 18, stepSize: 0.03 },
      { layer: "mixed_6c", channel: 144, iterations: 18, stepSize: 0.03 },
    ],
  },
]);
export function originTreatment(depth) {
  const t = originClamp(depth, 0, 2) / 2;
  return {
    neon: originSmooth(t) * 0.35,
    hex: originSmooth(t) * 0.34,
    corruption: originSmooth(t) * 0.72,
  };
}
export class OriginSpace {
  constructor() {
    this.position = [0, 0];
    this.yaw = 0;
    this.pitch = 0;
    this.speed = 2.5;
    this.enabled = false;
    this.portal = [0, -12];
    this.portalYaw = 0;
    this.frontier = 0;
    this.trace = [];
  }
  move(forward, right, seconds) {
    if (![forward, right, seconds].every(Number.isFinite) || seconds < 0)
      throw new RangeError("Invalid movement.");
    if (!this.enabled) return false;
    const length = Math.max(1, Math.hypot(forward, right)),
      step = (Math.min(0.1, seconds) * this.speed) / length;
    this.position[0] +=
      (Math.sin(this.yaw) * forward + Math.cos(this.yaw) * right) * step;
    this.position[1] +=
      (-Math.cos(this.yaw) * forward + Math.sin(this.yaw) * right) * step;
    if (Math.hypot(forward, right) > 0) {
      const previous = this.trace.at(-1);
      if (
        !previous ||
        Math.hypot(
          this.position[0] - previous[0],
          this.position[1] - previous[1],
        ) > 0.35
      ) {
        this.trace.push([...this.position]);
        if (this.trace.length > 128) this.trace.shift();
      }
    }
    return !!(forward || right);
  }
  get nearPortal() {
    return (
      Math.hypot(
        this.position[0] - this.portal[0],
        this.position[1] - this.portal[1],
      ) < 3.6
    );
  }
  get parallax() {
    return this.enabled
      ? [
          Math.tanh(this.position[0] / 14) * 0.48,
          0,
          Math.tanh(this.position[1] / 14) * 0.48,
        ]
      : [0, 0, 0];
  }
  completeFold() {
    this.frontier++;
    this.portalYaw = this.yaw;
    this.portal = [
      this.position[0] + Math.sin(this.yaw) * 18,
      this.position[1] - Math.cos(this.yaw) * 18,
    ];
  }
  home() {
    this.position = [0, 0];
    this.yaw = 0;
    this.pitch = 0;
    this.portal = [0, -12];
    this.portalYaw = 0;
    this.frontier = 0;
    this.trace = [];
  }
}
