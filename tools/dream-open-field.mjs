// Continuous drift: no rooms, exits, unlocks or destination graph.
export const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const smooth = (v) => {
  const t = clamp(v);
  return t * t * (3 - 2 * t);
};
export const mix = (a, b, t) => a + (b - a) * t;
export function fieldHash(x, z, seed = 417) {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ seed;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
export function fieldNoise(x, z, seed) {
  const a = Math.floor(x),
    b = Math.floor(z),
    u = smooth(x - a),
    v = smooth(z - b);
  return mix(
    mix(fieldHash(a, b, seed), fieldHash(a + 1, b, seed), u),
    mix(fieldHash(a, b + 1, seed), fieldHash(a + 1, b + 1, seed), u),
    v,
  );
}
export const ENCOUNTERS = Object.freeze([
  {
    name: "Nested echo",
    description: "Distances fold into gentle repetitions.",
  },
  {
    name: "Liquid field",
    description: "A slow ripple passes through the image.",
  },
  {
    name: "Hex bloom",
    description: "The colored weave briefly comes forward.",
  },
  {
    name: "Distant fold",
    description: "A temporary elsewhere. The field returns on its own.",
  },
]);
export function openAppearance(depth) {
  const t = smooth(depth / 3);
  return { neon: t * 0.35, hex: t, corruption: t * 0.72 };
}
// Return a separate effective parameter object; never overwrite manual sliders.
export function driftWaves(base, time, depth, amount, seed = 417) {
  const a = clamp(amount),
    d = clamp(depth / 3);
  const breath = Math.sin(time * 0.073 + seed * 0.01),
    slow = Math.sin(time * 0.031 + 1.7);
  const out = { ...base };
  out.gain = clamp(base.gain + a * (0.055 + d * 0.09 + breath * 0.065));
  out.frequency = clamp(
    base.frequency * (1 + a * (slow * 0.13 + d * 0.08)),
    1,
    30,
  );
  out.speed = clamp(base.speed * (1 + a * (breath * 0.22 + d * 0.2)), 0, 3);
  out.eccentricity = clamp(
    base.eccentricity * (1 + a * slow * 0.25),
    0.005,
    0.5,
  );
  out.neuralSwell = clamp(base.neuralSwell + a * (d * 0.08 + breath * 0.035));
  out.edgeCoupling = clamp(
    base.edgeCoupling + a * (0.035 + d * 0.08 + slow * 0.045),
  );
  out.chromaticDispersion = clamp(
    base.chromaticDispersion + a * (d * 0.07 + breath * 0.035),
  );
  if (a === 0) return { ...base };
  return out;
}
export class OpenDriftField {
  constructor(seed = 417) {
    this.seed = seed;
    this.offset = [0, 0];
    this.age = 0;
    this.distance = 0;
    this.depth = 0;
    this.autoDepth = true;
    this.autoWaves = true;
    this.strength = 0.65;
    this.waveAmount = 0.65;
    this.wavePhase = 0;
    this.effect = null;
    this.recent = new Map();
  }
  global(position) {
    return position.map((v, i) => v + this.offset[i]);
  }
  rebase(position) {
    for (let i = 0; i < 2; i++)
      if (Math.abs(position[i]) > 128) {
        const shift = Math.trunc(position[i] / 96) * 96;
        position[i] -= shift;
        this.offset[i] += shift;
      }
    return position;
  }
  advance(dt, moved, base) {
    this.age += dt;
    this.distance += moved;
    if (this.autoDepth)
      this.depth = clamp(this.depth + dt / 90 + moved / 160, 0, 3);
    const target = this.autoWaves ? this.strength : 0;
    this.waveAmount = mix(this.waveAmount, target, 1 - Math.exp(-dt / 1.8));
    if (Math.abs(this.waveAmount - target) < 0.0001) this.waveAmount = target;
    this.wavePhase +=
      dt *
      driftWaves(base, this.age, this.depth, this.waveAmount, this.seed).speed;
    if (this.effect) {
      this.effect.elapsed += dt;
      if (this.effect.elapsed >= this.effect.duration) this.effect = null;
    }
  }
  descriptor(position, landscapes = true) {
    let [x, z] = this.global(position);
    if (this.effect?.type === 3) {
      x += this.effect.shift[0];
      z += this.effect.shift[1];
    }
    // Nested spatial frequencies produce broad, overlapping landscape tendencies.
    const t = this.age / 115,
      a = Math.floor(x / 48 + t * 0.31),
      b = Math.floor(z / 48 - t * 0.19);
    const h = fieldHash(a, b, this.seed),
      n = fieldNoise(x / 130 + t, z / 130, this.seed + 23);
    const stage = this.depth < 0.55 ? 0 : this.depth < 1.65 ? 1 : 2;
    const landscape =
      landscapes && this.depth > 0.6 && (n > 0.37 || this.effect?.type === 3)
        ? Math.floor(h * 3)
        : -1;
    return {
      key: `${a}:${b}:${stage}:${landscape}`,
      stage,
      landscape,
      channel: 40 + Math.floor(h * 170),
      layer: h < 0.5 ? "mixed_6a" : "mixed_6c",
      iterations: 6 + Math.floor(h * 5),
      stepSize: 0.016 + Math.min(3, this.depth) * 0.004,
    };
  }
  arches(position) {
    const [x, z] = this.global(position),
      cx = Math.floor(x / 42),
      cz = Math.floor(z / 42),
      all = [];
    const add = (id, wx, wz, h, first = false) => {
      const local = [wx - this.offset[0], wz - this.offset[1]],
        distance = Math.hypot(wx - x, wz - z);
      if (distance > 48 || this.age - (this.recent.get(id) ?? -1000) < 45)
        return;
      const yaw = first ? Math.atan2(wx, -wz) : h * Math.PI * 2;
      all.push({
        id,
        position: local,
        yaw,
        radius: 1.5 + h * 1.1,
        type: Math.floor(h * 4),
        twist: h * 2 - 1,
        phase: h * 12,
        distance,
        presence: smooth((48 - distance) / 12) * (this.effect ? 0.25 : 1),
      });
    };
    add("first", 5, -14, fieldHash(9, 5, this.seed), true);
    for (let a = cx - 1; a <= cx + 1; a++)
      for (let b = cz - 1; b <= cz + 1; b++) {
        const h = fieldHash(a, b, this.seed + 5);
        if (h < 0.42 || (a === 0 && b === -1)) continue;
        add(
          `${a}:${b}`,
          (a + 0.2 + h * 0.6) * 42,
          (b + 0.2 + fieldHash(a, b, this.seed + 7) * 0.6) * 42,
          h,
        );
      }
    return all.sort((a, b) => a.distance - b.distance).slice(0, 3);
  }
  crossed(before, after) {
    if (this.effect) return null;
    return (
      this.arches(after).find((a) => {
        const f = [Math.sin(a.yaw), -Math.cos(a.yaw)],
          r = [Math.cos(a.yaw), Math.sin(a.yaw)];
        const p = before.map((v, i) => v - a.position[i]),
          q = after.map((v, i) => v - a.position[i]);
        return (
          (p[0] * f[0] + p[1] * f[1]) * (q[0] * f[0] + q[1] * f[1]) <= 0 &&
          Math.abs(q[0] * r[0] + q[1] * r[1]) < a.radius * 0.82
        );
      }) || null
    );
  }
  encounter(arch) {
    if (this.effect) return false;
    const h = fieldHash(Math.floor(this.age), arch.type, this.seed);
    this.effect = {
      type: arch.type,
      elapsed: 0,
      duration: 22 + h * 12,
      shift: [320 + h * 400, -480 - h * 300],
    };
    this.recent.set(arch.id, this.age);
    while (this.recent.size > 32)
      this.recent.delete(this.recent.keys().next().value);
    return true;
  }
  get effectAmount() {
    const e = this.effect;
    return e ? smooth(e.elapsed / 3) * smooth((e.duration - e.elapsed) / 5) : 0;
  }
  mappingAt(position) {
    const [x, z] = this.global(position);
    return [
      Math.sin(x / 120) * 0.13 + Math.sin(z / 150) * 0.045,
      Math.sin(z / 150) * 0.055,
    ];
  }
}
