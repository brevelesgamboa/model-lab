const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function createPlaneMesh(resolution = 256) {
  if (!Number.isInteger(resolution) || resolution < 2 || resolution > 256)
    throw new RangeError("Plane resolution must be between 2 and 256.");
  const vertices = new Float32Array(resolution * resolution * 5);
  const indices = new Uint16Array((resolution - 1) ** 2 * 6);
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const u = x / (resolution - 1),
        v = y / (resolution - 1);
      vertices.set([2 * u - 1, 2 * v - 1, 0, u, v], (y * resolution + x) * 5);
    }
  }
  let offset = 0;
  for (let y = 0; y < resolution - 1; y++) {
    for (let x = 0; x < resolution - 1; x++) {
      const a = y * resolution + x,
        b = a + 1,
        c = a + resolution,
        d = c + 1;
      indices.set([a, b, c, b, d, c], offset);
      offset += 6;
    }
  }
  return { vertices, indices, resolution };
}

export function multiplyMatrices(a, b) {
  const result = new Float32Array(16);
  for (let column = 0; column < 4; column++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++)
        result[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
  return result;
}

const normalize = (v) => {
  const length = Math.hypot(...v) || 1;
  return v.map((x) => x / length);
};
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);

export class OrbitCamera {
  constructor() {
    this.reset();
  }
  reset() {
    this.yaw = 0;
    this.pitch = 0;
    this.distance = 3.2;
    this.target = [0, 0, 0.15];
  }
  orbit(dx, dy) {
    this.yaw = (this.yaw - dx * 0.008) % (2 * Math.PI);
    this.pitch = clamp(this.pitch + dy * 0.008, -1.35, 1.35);
  }
  zoom(delta) {
    this.distance = clamp(
      this.distance * Math.exp(clamp(delta, -1000, 1000) * 0.001),
      1.25,
      12,
    );
  }
  pan(dx, dy, height) {
    const { right, up } = this.basis();
    const scale =
      (2 * this.distance * Math.tan(Math.PI / 8)) / Math.max(1, height);
    this.target = this.target.map((x, i) =>
      clamp(x + (-right[i] * dx + up[i] * dy) * scale, -4, 4),
    );
  }
  basis() {
    const direction = [
      Math.cos(this.pitch) * Math.sin(this.yaw),
      Math.sin(this.pitch),
      Math.cos(this.pitch) * Math.cos(this.yaw),
    ];
    const position = this.target.map(
      (x, i) => x + this.distance * direction[i],
    );
    const right = normalize(cross([0, 1, 0], direction));
    const up = cross(direction, right);
    return { direction, position, right, up };
  }
  matrices(aspect = 1) {
    const { direction: z, position, right: x, up: y } = this.basis();
    const view = new Float32Array([
      x[0],
      y[0],
      z[0],
      0,
      x[1],
      y[1],
      z[1],
      0,
      x[2],
      y[2],
      z[2],
      0,
      -dot(x, position),
      -dot(y, position),
      -dot(z, position),
      1,
    ]);
    const f = 1 / Math.tan(Math.PI / 8),
      near = 0.05,
      far = 40;
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
    return { mvp: multiplyMatrices(projection, view), position };
  }
}
