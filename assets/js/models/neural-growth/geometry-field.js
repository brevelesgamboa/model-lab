/*
 * SPDX-License-Identifier: Apache-2.0
 * Shared geometry for the adapted Texture NCA runtime.
 * See models/neural-growth/NOTICE.md.
 */
// One field definition for directional perception and echo advection. Angles are
// circular quantities; interpolating their coefficients can erase a kernel.
export const SPIRAL_MAX_PITCH_DEGREES = 89;
export const SPIRAL_MAX_PITCH_RADIANS = (SPIRAL_MAX_PITCH_DEGREES * Math.PI) / 180;

export const ANGLE_GLSL = `
const float GEOMETRY_PI = 3.141592653589793;
const float GEOMETRY_TAU = 6.283185307179586;
bool finiteAngle(float angle) { return !isnan(angle) && !isinf(angle); }
float directionAngle(vec2 direction, float fallback) {
  if (!finiteAngle(fallback)) fallback = 0.0;
  if (any(isnan(direction)) || any(isinf(direction)) || dot(direction, direction) < 1e-12) return fallback;
  return atan(direction.y, direction.x);
}
float circularMix(float base, float target, float weight) {
  if (!finiteAngle(base)) base = 0.0;
  if (!finiteAngle(target) || !finiteAngle(weight)) return base;
  float arc = mod(target - base + GEOMETRY_PI, GEOMETRY_TAU) - GEOMETRY_PI;
  return base + clamp(weight, 0.0, 1.0) * arc;
}
vec2 angleDirection(float angle) {
  if (!finiteAngle(angle)) angle = 0.0;
  return vec2(cos(angle), sin(angle));
}
`;

export const GEOMETRY_GLSL = `${ANGLE_GLSL}
float geometryAngle(vec2 pos, float base) {
  if (!finiteAngle(base)) base = 0.0;
  if (u_transform == 0 || u_geometryStrength <= 0.0) return base;
  float softness = clamp(u_geometrySoftness, 0.0, 1.0);
  float r = length(pos);
  // At least two texels; the angular influence vanishes smoothly at a focus.
  float core = max(4.0 / float(u_size), mix(0.025, 0.30, softness));
  float influence = 1.0;
  float phi = directionAngle(pos, 0.0);
  float theta = base;
  if (u_transform == 1 || u_transform == 2 || u_transform == 6 || u_transform == 7) {
    influence = smoothstep(0.0, core, r);
  }
  if (u_transform == 1) {
    theta = phi + GEOMETRY_PI * 0.5 + u_twist + base;
  } else if (u_transform == 2) {
    float pitch = clamp(u_twist, -${SPIRAL_MAX_PITCH_RADIANS}, ${SPIRAL_MAX_PITCH_RADIANS});
    float slope = tan(pitch);
    // Soft saturation preserves ordinary pitches and expressive tight spirals,
    // without the ~57x winding rate of tan(89 degrees). The radial filter also
    // limits the phase gradient to the simulation's texel footprint.
    slope /= sqrt(1.0 + (slope / 8.0) * (slope / 8.0));
    float spiralCore = max(core, abs(slope) * 2.0 / (float(u_size) * 0.65));
    float radius = sqrt(r * r + spiralCore * spiralCore);
    influence = smoothstep(0.0, spiralCore, r);
    theta = phi + GEOMETRY_PI * 0.5 + log(radius) * slope + base;
  } else if (u_transform == 3) {
    vec2 z = pos * 1.25;
    for (int i = 0; i < 5; i++) {
      z = vec2(z.x * z.x - z.y * z.y - 0.8, 2.0 * z.x * z.y + 0.156);
    }
    theta = directionAngle(z, -u_twist) + u_twist + base;
    influence = smoothstep(0.0, 0.15, length(z));
  } else if (u_transform == 4 || u_transform == 8) {
    float spacing = u_transform == 4 ? 0.45 : mix(0.25, 0.65, clamp(softness * 1.5, 0.0, 1.0));
    vec2 p1 = pos - vec2(-spacing, 0.0);
    vec2 p2 = pos - vec2(spacing, 0.0);
    float d1 = dot(p1, p1) + 0.01 + softness * 0.15;
    float d2 = dot(p2, p2) + 0.01 + softness * 0.15;
    // A dipole has opposite circulations. For a vortex pair, Twist continuously
    // moves the second circulation from counter-spin through zero to co-spin.
    float secondSpin = -1.0;
    if (u_transform == 8) {
      secondSpin = (2.0 * smoothstep(-0.35, 0.0, u_twist) - 1.0) * max(0.2, 1.0 - abs(u_twist) * 0.45);
    }
    vec2 flow = vec2(-p1.y / d1 - secondSpin * p2.y / d2, p1.x / d1 + secondSpin * p2.x / d2);
    float turn = u_transform == 4 ? u_twist : 0.0;
    theta = directionAngle(flow, -turn) + turn + base;
    influence = smoothstep(0.0, 0.15, length(flow));
  } else if (u_transform == 5) {
    float phase = pos.y * GEOMETRY_TAU + pos.x * sin(u_twist) * GEOMETRY_PI + base;
    theta = base + sin(phase) * (0.85 + abs(u_twist) * 0.5) + u_twist;
  } else if (u_transform == 6) {
    theta = directionAngle(vec2(pos.x, -pos.y), 0.0) + u_twist + base;
  } else if (u_transform == 7) {
    float sector = GEOMETRY_TAU / clamp(u_foldCount, 3.0, 12.0);
    float folded = abs(mod(phi + sector * 0.5, sector) - sector * 0.5);
    // A continuous triangle wave, rather than adding a discontinuous sector ID.
    theta = phi + folded * 2.0 + GEOMETRY_PI * 0.5 + u_twist + base;
  } else if (u_transform == 9) {
    vec2 grid = pos * mix(2.2, 4.2, softness);
    vec2 cell = floor(grid), local = fract(grid);
    vec2 nearest = vec2(0.0), second = vec2(0.0);
    float minDist = 10.0, secondDist = 10.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 neighbor = vec2(float(x), float(y));
      vec2 site = cell + neighbor;
      vec2 seed = 0.5 + 0.38 * sin(vec2(dot(site, vec2(127.1, 311.7)), dot(site, vec2(269.5, 183.3))));
      vec2 diff = neighbor + seed - local;
      float dist = dot(diff, diff);
      if (dist < minDist) {
        secondDist = minDist; second = nearest; minDist = dist; nearest = diff;
      } else if (dist < secondDist) { secondDist = dist; second = diff; }
    }
    vec2 normal = second - nearest;
    // Canonical site ordering keeps the wall tangent unchanged when the nearest
    // and second-nearest sites exchange places on either side of a boundary.
    if (normal.x < 0.0 || (normal.x == 0.0 && normal.y < 0.0)) normal = -normal;
    float wallAngle = directionAngle(vec2(-normal.y, normal.x), 0.0);
    float islandAngle = directionAngle(nearest, wallAngle - GEOMETRY_PI * 0.5) + GEOMETRY_PI * 0.5;
    float wallDist = max(0.0, sqrt(secondDist) - sqrt(minDist));
    float width = mix(0.35, 0.6, softness) * (1.0 - clamp(u_twist * 0.8, -0.6, 0.6));
    // Full wall influence at a shared boundary is essential for continuity;
    // Twist adjusts its width, rather than exposing the discontinuous site ID.
    float wallWeight = 1.0 - smoothstep(0.02, width, wallDist);
    theta = circularMix(islandAngle, wallAngle, wallWeight) + clamp(u_twist * 0.7, -1.0, 1.0) * GEOMETRY_PI * 0.5 + base;
  }
  float edge = mix(1.0, 1.0 - smoothstep(0.4, 1.3, r), softness);
  return circularMix(base, theta, u_geometryStrength * edge * influence);
}
`;
