const TAU = Math.PI * 2;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function createDomeMesh(resolution = 256) {
  if (!Number.isInteger(resolution) || resolution < 4 || resolution > 256)
    throw new RangeError("Dome resolution must be between 4 and 256.");
  const vertices = new Float32Array(resolution * resolution * 5);
  const indices = new Uint16Array((resolution - 1) * (resolution - 2) * 6);
  for (let y = 0; y < resolution; y++) {
    const v = y / (resolution - 1),
      latitude = (v - 0.5) * Math.PI;
    const ring = y === 0 || y === resolution - 1 ? 0 : Math.cos(latitude);
    for (let x = 0; x < resolution; x++) {
      const u = x / (resolution - 1),
        longitude = (u - 0.5) * TAU;
      // Identical seam and pole positions avoid cracks after displacement.
      const sx = x === 0 || x === resolution - 1 ? 0 : Math.sin(longitude);
      vertices.set(
        [sx * ring, Math.sin(latitude), -Math.cos(longitude) * ring, u, v],
        (y * resolution + x) * 5,
      );
    }
  }
  let offset = 0;
  for (let y = 0; y < resolution - 1; y++) {
    for (let x = 0; x < resolution - 1; x++) {
      const a = y * resolution + x,
        b = a + 1,
        c = a + resolution,
        d = c + 1;
      // CCW from inside; omit zero-area triangles at the two poles.
      if (y > 0) {
        indices.set([a, b, c], offset);
        offset += 3;
      }
      if (y < resolution - 2) {
        indices.set([b, d, c], offset);
        offset += 3;
      }
    }
  }
  return { vertices, indices, resolution };
}

export function raycastSphereUV(rayDir, isMirrored = true) {
  const x = rayDir[0],
    y = rayDir[1],
    z = rayDir[2];
  const len = Math.hypot(x, y, z);
  if (len < 1e-9) return { u: 0.5, v: 0.5 };
  const nx = x / len,
    ny = y / len,
    nz = z / len;

  const sphereU = Math.atan2(nx, -nz) / TAU + 0.5;
  const sphereV = Math.asin(clamp(ny, -1, 1)) / Math.PI + 0.5;

  if (!isMirrored) {
    return { u: sphereU, v: 1.0 - sphereV };
  }

  const rawX = sphereU - 0.25;
  const rawY = sphereV - 0.25;
  const mod2 = (val) => ((val % 2) + 2) % 2;
  let mirX = Math.abs(mod2(rawX * 2 - 1) - 1);
  const mirY = Math.abs(mod2(rawY * 2 - 1) - 1);

  const cap = Math.min(sphereV, 1.0 - sphereV) / 0.08;
  const capSmooth = cap <= 0 ? 0 : cap >= 1 ? 1 : cap * cap * (3 - 2 * cap);
  mirX = 0.5 * (1 - capSmooth) + mirX * capSmooth;

  return { u: mirX, v: 1.0 - mirY };
}

export class DomeCamera {
  constructor() {
    this.reset();
  }
  reset() {
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.dolly = 0;
    this.scrollDolly = 0;
    this.target = [0, 0, 0];
  }
  look(dx, dy) {
    this.yaw =
      ((((this.yaw - dx * 0.006 + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
    const limit = (89 * Math.PI) / 180;
    this.pitch = clamp(this.pitch + dy * 0.006, -limit, limit);
  }
  zoom(delta) {
    const step = clamp(delta, -1000, 1000) * 0.0015;
    this.scrollDolly = clamp((this.scrollDolly || 0) - step, -2.5, 2.5);
  }
  pan(dx, dy, height) {
    const sy = Math.sin(this.yaw),
      cy = Math.cos(this.yaw),
      sp = Math.sin(this.pitch),
      cp = Math.cos(this.pitch);
    const right = [cy, 0, sy];
    const up = [-sy * sp, cp, cy * sp];
    const scale = (3.5 * Math.tan((85 * Math.PI) / 360)) / Math.max(1, height);
    this.target = this.target || [0, 0, 0];
    this.target[0] = clamp(this.target[0] + (-right[0] * dx + up[0] * dy) * scale, -2.5, 2.5);
    this.target[1] = clamp(this.target[1] + (-right[1] * dx + up[1] * dy) * scale, -2.5, 2.5);
    this.target[2] = clamp(this.target[2] + (-right[2] * dx + up[2] * dy) * scale, -2.5, 2.5);
  }
  matrices(aspect = 1) {
    const sy = Math.sin(this.yaw),
      cy = Math.cos(this.yaw),
      sp = Math.sin(this.pitch),
      cp = Math.cos(this.pitch);
    const direction = [sy * cp, sp, -cy * cp];
    const baseRight = [cy, 0, sy];
    const baseUp = [-sy * sp, cp, cy * sp];
    const roll = this.roll || 0;
    const sr = Math.sin(roll);
    const cr = Math.cos(roll);
    const right = [
      baseRight[0] * cr + baseUp[0] * sr,
      baseRight[1] * cr + baseUp[1] * sr,
      baseRight[2] * cr + baseUp[2] * sr,
    ];
    const up = [
      -baseRight[0] * sr + baseUp[0] * cr,
      -baseRight[1] * sr + baseUp[1] * cr,
      -baseRight[2] * sr + baseUp[2] * cr,
    ];
    const back = [-direction[0], -direction[1], -direction[2]];
    const totalDolly = (this.dolly || 0) + (this.scrollDolly || 0);
    const tgt = this.target || [0, 0, 0];
    const position = [
      tgt[0] + direction[0] * totalDolly,
      tgt[1] + direction[1] * totalDolly,
      tgt[2] + direction[2] * totalDolly,
    ];
    const tx = -(right[0] * position[0] + right[1] * position[1] + right[2] * position[2]) || 0;
    const ty = -(up[0] * position[0] + up[1] * position[1] + up[2] * position[2]) || 0;
    const tz = -(back[0] * position[0] + back[1] * position[1] + back[2] * position[2]) || 0;
    const view = new Float32Array([
      right[0],
      up[0],
      back[0],
      0,
      right[1],
      up[1],
      back[1],
      0,
      right[2],
      up[2],
      back[2],
      0,
      tx,
      ty,
      tz,
      1,
    ]);
    const f = 1 / Math.tan((85 * Math.PI) / 360),
      near = 0.05,
      far = 20;
    const projection = new Float32Array([
      f / Math.max(0.01, aspect),
      0,
      0,
      0,
      0,
      f,
      0,
      0,
      0,
      0,
      (far + near) / (near - far),
      -1,
      0,
      0,
      (2 * far * near) / (near - far),
      0,
    ]);
    return { view, projection, direction, position };
  }
}
