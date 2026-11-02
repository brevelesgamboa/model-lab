export const DREAM_CELL_SIZE = 18;

export const DREAM_ROOM_TYPES = Object.freeze(
  [
    {
      id: 0,
      name: "Atrium",
      radius: 24,
      density: 0.25,
      recursion: 0.25,
      corruption: 0.15,
      relief: 0.8,
    },
    {
      id: 1,
      name: "Filament corridor",
      radius: 12,
      density: 0.8,
      recursion: 0.85,
      corruption: 0.32,
      relief: 1,
    },
    {
      id: 2,
      name: "High-relief spire",
      radius: 18,
      density: 0.85,
      recursion: 0.58,
      corruption: 0.28,
      relief: 1.5,
    },
    {
      id: 3,
      name: "Cyber void",
      radius: 22,
      density: 0.55,
      recursion: 0.42,
      corruption: 0.88,
      relief: 1.2,
    },
  ].map(Object.freeze),
);

export function getRoomTypology(x, z, seed) {
  return DREAM_ROOM_TYPES[dreamCellHash(x, z, seed) % 4];
}

// Integer arithmetic matches the shader, including negative grid coordinates.
export function dreamCellHash(x, z, seed) {
  let h = (Math.imul(x, 73856093) ^ Math.imul(z, 19349663) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
export function dreamBridge(x, z, seed) {
  return (x === 0 && z === 0) || dreamCellHash(x, z, seed) % 7 > 2;
}
export function dreamWarp([x, z], seed) {
  const phase = (seed % 1024) * 0.013;
  return [
    x + 1.8 * Math.sin(z * 0.14 + phase) - 1.8 * Math.sin(phase),
    z + 1.8 * Math.sin(x * 0.13 - phase) + 1.8 * Math.sin(phase),
  ];
}
export function dreamUnwarp([x, z], seed) {
  let p = [x, z];
  for (let i = 0; i < 8; i++) {
    const warped = dreamWarp(p, seed);
    p = [p[0] + x - warped[0], p[1] + z - warped[1]];
  }
  return p;
}
export function dreamMapSegments(position, seed, radius = 3) {
  const cell = dreamWarp(position, seed).map((n) =>
    Math.round(n / DREAM_CELL_SIZE),
  );
  const segments = [];
  for (let z = cell[1] - radius; z <= cell[1] + radius; z++)
    for (let x = cell[0] - radius; x <= cell[0] + radius; x++) {
      for (const [dx, dz] of [
        [0, 1],
        [1, 0],
      ]) {
        if (dx && !dreamBridge(x, z, seed)) continue;
        const points = Array.from({ length: 9 }, (_, i) =>
          dreamUnwarp(
            [
              (x + (dx * i) / 8) * DREAM_CELL_SIZE,
              (z + (dz * i) / 8) * DREAM_CELL_SIZE,
            ],
            seed,
          ),
        );
        segments.push({
          id: `${x},${z}:${dx}`,
          points,
          motif: dreamCellHash(x, z, seed) % 4,
        });
      }
    }
  return segments;
}
