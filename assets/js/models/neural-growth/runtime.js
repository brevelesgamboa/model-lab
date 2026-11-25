/*
 * SPDX-License-Identifier: Apache-2.0
 * Adapted from Google Research's Texture NCA browser implementation.
 * Changes: WebGL2 without TWGL, one checkpoint, horizontal RGBA packing,
 * deterministic sparse updates, explicit disposal and state-safe drawing.
 * See models/neural-growth/NOTICE.md and licenses/neural-growth-Apache-2.0.txt.
 */
import {
  CHANNELS,
  createInitialState,
  createSparseLayout,
  validateSeed,
  validateSize,
} from "./reference.js";
import { ResonanceConfig } from "./resonance-config.js";
import {
  MOTION_GRID_SIZE,
  limitMotionField,
  motionFieldStats,
} from "./motion-field.js";

import { GpuVitalityProbe, PROBE_SIZE, SNAPSHOT_SIZE } from "./vitality-probe.js";
import { INTENT_SIZE } from "./vitality-watchdog.js";

let nextRuntimeGeneration = 0;

export const SPIRAL_MAX_PITCH_DEGREES = 89;
export const SPIRAL_MAX_PITCH_RADIANS = (SPIRAL_MAX_PITCH_DEGREES * Math.PI) / 180;

const TRANSFORM_CODES = Object.freeze({
  cartesian: 0,
  vortex: 1,
  spiral: 2,
  julia: 3,
  dipole: 4,
  wave: 5,
  saddle: 6,
  kaleidoscope: 7,
  vortex_pair: 8,
  voronoi: 9,
});

// Guard the combined manual, audio and LFO values at the runtime boundary.
export function clampGeometryTwist(transform, value) {
  const angle = Number(value);
  if (!Number.isFinite(angle)) return 0;
  return transform === "spiral"
    ? Math.max(-SPIRAL_MAX_PITCH_RADIANS, Math.min(SPIRAL_MAX_PITCH_RADIANS, angle))
    : angle;
}

export function clampGeometryStrength(value) {
  const strength = Number(value);
  return Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 1;
}

const VERTEX = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const PREFIX = `#version 300 es
precision highp float;
precision highp int;
uniform int u_size;
out vec4 out_color;
vec4 decodeState(vec4 value) { return (value - 127.0 / 255.0) * 4.0; }
vec4 encodeState(vec4 value) { return value / 4.0 + 127.0 / 255.0; }
ivec2 wrapCell(ivec2 p) { return (p % u_size + u_size) % u_size; }
`;

// Fixed stratified sites cover the whole torus and retain identical positions
// between probes. Moments, energy and clipping are measured before reduction.
const PROBE_SAMPLING = `
ivec2 probeCell(ivec2 site) {
  uint hash = uint(site.x) * 1664525u + uint(site.y) * 1013904223u;
  hash ^= hash >> 16;
  vec2 jitter = vec2(float(hash & 65535u), float((hash >> 16) & 65535u)) / 65536.0;
  return min(ivec2((vec2(site) + jitter) * float(u_size) / ${SNAPSHOT_SIZE}.0), ivec2(u_size - 1));
}
`;
const VITALITY_SNAPSHOT = `${PREFIX}
uniform sampler2D u_state;
${PROBE_SAMPLING}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int group = p.x / ${SNAPSHOT_SIZE};
  ivec2 xy = probeCell(ivec2(p.x % ${SNAPSHOT_SIZE}, p.y));
  out_color = texelFetch(u_state, ivec2(xy.x + group * u_size, xy.y), 0);
}`;
const VITALITY_PROBE = `${PREFIX}
uniform sampler2D u_state;
uniform sampler2D u_previous;
uniform sampler2D u_barrier;
uniform sampler2D u_intent;
uniform int u_hasHistory;
${PROBE_SAMPLING}
vec2 encode16(float value) {
  float bits = floor(clamp(value, 0.0, 1.0) * 65535.0 + 0.5);
  return vec2(floor(bits / 256.0), mod(bits, 256.0)) / 255.0;
}
float clipped(vec4 value) {
  return dot(vec4(lessThanEqual(value, vec4(2.0 / 255.0))), vec4(1.0))
    + dot(vec4(greaterThanEqual(value, vec4(253.0 / 255.0))), vec4(1.0));
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int lane = p.x / ${PROBE_SIZE};
  ivec2 tile = ivec2(p.x % ${PROBE_SIZE}, p.y);
  vec3 rgb = vec3(0.0), squared = vec3(0.0);
  float energy = 0.0, delta = 0.0, clip = 0.0, coverage = 0.0, rgbEnergy = 0.0, rgbDelta = 0.0;
  for (int sy = 0; sy < 2; sy++) for (int sx = 0; sx < 2; sx++) {
    ivec2 site = tile * 2 + ivec2(sx, sy);
    ivec2 xy = probeCell(site);
    ivec2 intentCell = min(xy * ${INTENT_SIZE} / u_size, ivec2(${INTENT_SIZE - 1}));
    if (texelFetch(u_barrier, xy, 0).r > 0.5 || texelFetch(u_intent, intentCell, 0).r > 0.5) continue;
    vec4 a = texelFetch(u_state, xy, 0);
    vec4 b = texelFetch(u_state, ivec2(xy.x + u_size, xy.y), 0);
    vec4 c = texelFetch(u_state, ivec2(xy.x + u_size * 2, xy.y), 0);
    vec4 oldA = texelFetch(u_previous, site, 0);
    vec4 oldB = texelFetch(u_previous, ivec2(site.x + ${SNAPSHOT_SIZE}, site.y), 0);
    vec4 oldC = texelFetch(u_previous, ivec2(site.x + ${SNAPSHOT_SIZE * 2}, site.y), 0);
    vec4 hb = (b - 127.0 / 255.0) * 2.0, hc = (c - 127.0 / 255.0) * 2.0;
    float ha = (a.a - 127.0 / 255.0) * 2.0;
    vec4 db = b - oldB, dc = c - oldC;
    float da = a.a - oldA.a;
    rgb += a.rgb;
    squared += a.rgb * a.rgb;
    energy += sqrt((dot(hb, hb) + dot(hc, hc) + ha * ha) / 9.0);
    delta += u_hasHistory == 1 ? sqrt((dot(db, db) + dot(dc, dc) + da * da) / 9.0) : 0.0;
    clip += (clipped(a) + clipped(b) + clipped(c)) / 12.0;
    rgbEnergy += dot(abs(a.rgb - 127.0 / 255.0), vec3(1.0 / 3.0));
    rgbDelta += u_hasHistory == 1 ? dot(abs(a.rgb - oldA.rgb), vec3(1.0 / 3.0)) : 0.0;
    coverage += 1.0;
  }
  float divisor = max(coverage, 1.0);
  rgb /= divisor; squared /= divisor;
  vec2 values;
  if (lane == 0) values = rgb.rg;
  else if (lane == 1) values = vec2(rgb.b, squared.r);
  else if (lane == 2) values = squared.gb;
  else if (lane == 3) values = vec2(energy, delta) / divisor;
  else if (lane == 4) values = vec2(clip / divisor, coverage / 4.0);
  else values = vec2(rgbEnergy, rgbDelta) / divisor;
  out_color = vec4(encode16(values.x), encode16(values.y));
}`;

const PERCEPTION = `${PREFIX}
uniform sampler2D u_state;
uniform sampler2D u_shuffle;
uniform sampler2D u_orientation;
uniform ivec2 u_offset;
uniform float u_angle;
uniform float u_perceptionPhase;
uniform int u_topology;
uniform int u_transform;
uniform float u_twist;
uniform float u_geometryStrength;
uniform float u_geometryCenterX;
uniform float u_geometryCenterY;
uniform float u_geometrySoftness;
uniform float u_foldCount;
const int SX[9] = int[9](-1, 0, 1, -2, 0, 2, -1, 0, 1);
const int SY[9] = int[9](-1, -2, -1, 0, 0, 0, 1, 2, 1);
const int LP[9] = int[9](1, 2, 1, 2, -12, 2, 1, 2, 1);
const float HEX_SX[6] = float[6](2.0, -2.0, 1.0, -1.0, 1.0, -1.0);
const float HEX_SY[6] = float[6](0.0, 0.0, 1.7320508, 1.7320508, -1.7320508, -1.7320508);
const float HEX_LP[6] = float[6](2.0, 2.0, 2.0, 2.0, 2.0, 2.0);
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int halfSize = u_size / 2;
  int group = (p.y / halfSize) * 6 + (p.x / u_size);
  int band = group / 3;
  int inputGroup = group % 3;
  ivec2 packed = ivec2(p.x % u_size, p.y % halfSize);
  vec4 shuf = texelFetch(u_shuffle, packed, 0);
  ivec2 xy = wrapCell(ivec2(round(shuf.rg * 255.0 + shuf.ba * 255.0 * 256.0)) + u_offset);
  if (band == 0) {
    out_color = texelFetch(u_state, ivec2(xy.x + inputGroup * u_size, xy.y), 0);
    return;
  }
  float effectiveAngle = u_angle + u_perceptionPhase;
  float theta = effectiveAngle;
  float activeStrength = 0.0;
  float geometryStrength = clamp(u_geometryStrength, 0.0, 1.0);
  if (u_transform != 0 && geometryStrength > 0.0) {
    vec2 centerOffset = vec2(u_geometryCenterX, u_geometryCenterY);
    vec2 pos = ((vec2(xy) + 0.5) / (float(u_size) * 0.5) - 1.0) - centerOffset;
    float r = length(pos);
    float r_eff = sqrt(r * r + 0.0001 + u_geometrySoftness * 0.15);
    float phi = atan(pos.y, pos.x);
    float transTheta = effectiveAngle;
    if (u_transform == 1) {
      transTheta = phi + 1.5707963 + u_twist + effectiveAngle;
    } else if (u_transform == 2) {
      float pitch = clamp(u_twist, -${SPIRAL_MAX_PITCH_RADIANS}, ${SPIRAL_MAX_PITCH_RADIANS});
      transTheta = phi + 1.5707963 + log(max(r_eff, 0.01)) * tan(pitch) + effectiveAngle;
    } else if (u_transform == 3) {
      vec2 z = pos * 1.25;
      vec2 c = vec2(-0.8, 0.156);
      for (int i = 0; i < 5; i++) {
        z = vec2(z.x * z.x - z.y * z.y + c.x, 2.0 * z.x * z.y + c.y);
      }
      transTheta = atan(z.y, z.x) + u_twist + effectiveAngle;
    } else if (u_transform == 4) {
      vec2 p1 = pos - vec2(-0.45, 0.0);
      vec2 p2 = pos - vec2(0.45, 0.0);
      float d1 = dot(p1, p1) + 0.01 + u_geometrySoftness * 0.15;
      float d2 = dot(p2, p2) + 0.01 + u_geometrySoftness * 0.15;
      vec2 flow = vec2(-p1.y / d1 - p2.y / d2, p1.x / d1 + p2.x / d2);
      transTheta = atan(flow.y, flow.x) + u_twist + effectiveAngle;
    } else if (u_transform == 5) {
      float waveFreq = 6.2831853;
      float wavePhase = pos.y * waveFreq + pos.x * sin(u_twist) * 3.14159 + effectiveAngle;
      float waveOffset = sin(wavePhase) * (0.85 + abs(u_twist) * 0.5);
      transTheta = effectiveAngle + waveOffset + u_twist;
    } else if (u_transform == 6) {
      float saddleAngle = atan(-pos.y, pos.x);
      transTheta = saddleAngle + u_twist + effectiveAngle;
    } else if (u_transform == 7) {
      float folds = clamp(u_foldCount, 3.0, 12.0);
      float sectorAngle = 6.2831853 / folds;
      float halfSector = sectorAngle * 0.5;
      float phiNorm = mod(phi + 3.14159265, 6.2831853);
      float inSector = mod(phiNorm, sectorAngle);
      float folded = abs(inSector - halfSector);
      float petalAngle = (phiNorm - inSector) + (folded < halfSector * 0.5 ? folded : (halfSector - folded)) * 2.0;
      transTheta = petalAngle + 1.5707963 + u_twist + effectiveAngle;
    } else if (u_transform == 8) {
      float spacing = mix(0.25, 0.65, clamp(u_geometrySoftness * 1.5, 0.0, 1.0));
      vec2 p1 = pos - vec2(-spacing, 0.0);
      vec2 p2 = pos - vec2(spacing, 0.0);
      float d1 = dot(p1, p1) + 0.01 + u_geometrySoftness * 0.15;
      float d2 = dot(p2, p2) + 0.01 + u_geometrySoftness * 0.15;
      float twistMag = abs(u_twist);
      float w1 = 1.0;
      float spinSign = u_twist < -0.01 ? -1.0 : 1.0;
      float w2 = spinSign * max(0.2, 1.0 - twistMag * 0.45);
      vec2 flow = vec2(
        -w1 * p1.y / d1 - w2 * p2.y / d2,
        w1 * p1.x / d1 + w2 * p2.x / d2
      );
      transTheta = atan(flow.y, flow.x) + effectiveAngle;
    } else if (u_transform == 9) {
      float cellScale = mix(2.2, 4.2, u_geometrySoftness);
      vec2 gridCoord = pos * cellScale;
      vec2 i_coord = floor(gridCoord);
      vec2 f_coord = fract(gridCoord);
      vec2 minDiff = vec2(0.0);
      vec2 secondDiff = vec2(0.0);
      float minDist = 10.0;
      float secondMinDist = 10.0;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec2 neighbor = vec2(float(x), float(y));
          vec2 p = i_coord + neighbor;
          vec2 seed = 0.5 + 0.38 * sin(vec2(
            dot(p, vec2(127.1, 311.7)),
            dot(p, vec2(269.5, 183.3))
          ));
          vec2 diff = neighbor + seed - f_coord;
          float dist = dot(diff, diff);
          if (dist < minDist) {
            secondMinDist = minDist;
            secondDiff = minDiff;
            minDist = dist;
            minDiff = diff;
          } else if (dist < secondMinDist) {
            secondMinDist = dist;
            secondDiff = diff;
          }
        }
      }
      float d1 = sqrt(minDist);
      float d2 = sqrt(secondMinDist);
      float wallDist = max(0.0001, d2 - d1);
      vec2 safeMinDiff = length(minDiff) < 0.0001 ? vec2(0.0001, 0.0) : minDiff;
      float islandCircAngle = atan(safeMinDiff.y, safeMinDiff.x) + 1.5707963;
      vec2 wallVec = vec2(-(secondDiff.y - minDiff.y), secondDiff.x - minDiff.x);
      float wallAngle = atan(wallVec.y, wallVec.x);
      float wallBaseWeight = smoothstep(mix(0.35, 0.6, u_geometrySoftness), 0.02, wallDist);
      float wallWeight = clamp(wallBaseWeight * (1.0 - clamp(u_twist * 0.8, -0.6, 0.6)), 0.0, 1.0);
      float radialBlend = clamp(u_twist * 0.7, -1.0, 1.0);
      vec2 vIsland = vec2(cos(islandCircAngle), sin(islandCircAngle));
      vec2 vWall = vec2(cos(wallAngle), sin(wallAngle));
      vec2 vCell = mix(vIsland, vWall, wallWeight);
      float baseAngle = length(vCell) > 0.0001 ? atan(vCell.y, vCell.x) : islandCircAngle;
      transTheta = baseAngle + radialBlend * 1.5707963 + effectiveAngle;
    }
    float edgeFalloff = mix(1.0, smoothstep(1.3, 0.4, r), u_geometrySoftness);
    activeStrength = clamp(geometryStrength * edgeFalloff, 0.0, 1.0);
    theta = transTheta;
  }
  vec4 orient = texelFetch(u_orientation, xy, 0);
  if (orient.b > 0.05) {
    vec2 dir = orient.rg * 2.0 - 1.0;
    float groomedAngle = atan(dir.y, dir.x);
    theta = mix(theta, groomedAngle, orient.b);
  }
  float cosA = cos(theta);
  float sinA = sin(theta);
  if (u_transform != 0 && geometryStrength > 0.0 && activeStrength < 1.0) {
    // Blend perception coefficients directly, retaining grooming in both branches.
    float baseTheta = effectiveAngle;
    if (orient.b > 0.05) {
      vec2 dir = orient.rg * 2.0 - 1.0;
      baseTheta = mix(baseTheta, atan(dir.y, dir.x), orient.b);
    }
    cosA = mix(cos(baseTheta), cosA, activeStrength);
    sinA = mix(sin(baseTheta), sinA, activeStrength);
  }
  vec4 result = vec4(0.0);
  if (u_topology == 0) {
    for (int y = 0; y < 3; y++) {
      for (int x = 0; x < 3; x++) {
        ivec2 cell = wrapCell(xy + ivec2(x - 1, y - 1));
        vec4 value = vec4(round(texelFetch(u_state, ivec2(cell.x + inputGroup * u_size, cell.y), 0) * 255.0)) - 127.0;
        int k = y * 3 + x;
        float coefficient = band == 1
          ? (float(SX[k]) * cosA + float(SY[k]) * sinA)
          : (band == 2
            ? (-float(SX[k]) * sinA + float(SY[k]) * cosA)
            : float(LP[k]));
        result += value * coefficient;
      }
    }
  } else {
    int parity = xy.y % 2;
    ivec2 hexOffsets[6];
    hexOffsets[0] = ivec2(1, 0);
    hexOffsets[1] = ivec2(-1, 0);
    if (parity == 0) {
      hexOffsets[2] = ivec2(0, 1);
      hexOffsets[3] = ivec2(-1, 1);
      hexOffsets[4] = ivec2(0, -1);
      hexOffsets[5] = ivec2(-1, -1);
    } else {
      hexOffsets[2] = ivec2(1, 1);
      hexOffsets[3] = ivec2(0, 1);
      hexOffsets[4] = ivec2(1, -1);
      hexOffsets[5] = ivec2(0, -1);
    }
    for (int i = 0; i < 6; i++) {
      ivec2 cell = wrapCell(xy + hexOffsets[i]);
      vec4 value = vec4(round(texelFetch(u_state, ivec2(cell.x + inputGroup * u_size, cell.y), 0) * 255.0)) - 127.0;
      float coefficient = band == 1
        ? (HEX_SX[i] * cosA + HEX_SY[i] * sinA)
        : (band == 2
          ? (-HEX_SX[i] * sinA + HEX_SY[i] * cosA)
          : HEX_LP[i]);
      result += value * coefficient;
    }
    if (band == 3) {
      vec4 centerVal = vec4(round(texelFetch(u_state, ivec2(xy.x + inputGroup * u_size, xy.y), 0) * 255.0)) - 127.0;
      result -= centerVal * 12.0;
    }
  }
  vec4 encoded = clamp(floor((result + 1020.0) / 8.0), 0.0, 255.0);
  out_color = encoded / 255.0;
}`;

function denseShader(inputs, hiddenInput, hiddenOutput) {
  return `${PREFIX}
uniform sampler2D u_input;
uniform sampler2D u_weights;
uniform float u_scale;
uniform float u_activationWarp;
uniform float u_warpFrequency;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int halfSize = u_size / 2;
  ivec2 xy = ivec2(p.x % u_size, p.y % halfSize);
  int outputGroup = ${hiddenOutput ? "(p.y / halfSize) * 6 + (p.x / u_size)" : "p.x / u_size"};
  vec4 result = vec4(0.0);
  for (int group = 0; group < ${inputs / 4}; group++) {
    ivec2 inputCoord = ivec2(xy.x + (group % 6) * u_size, xy.y + (group / 6) * halfSize);
    vec4 value = texelFetch(u_input, inputCoord, 0);
    value = ${hiddenInput ? "value * 2.0" : "decodeState(value)"};
    int row = group * 4;
    result += value.x * (texelFetch(u_weights, ivec2(outputGroup, row), 0) - 127.0 / 255.0);
    result += value.y * (texelFetch(u_weights, ivec2(outputGroup, row + 1), 0) - 127.0 / 255.0);
    result += value.z * (texelFetch(u_weights, ivec2(outputGroup, row + 2), 0) - 127.0 / 255.0);
    result += value.w * (texelFetch(u_weights, ivec2(outputGroup, row + 3), 0) - 127.0 / 255.0);
  }
  result += texelFetch(u_weights, ivec2(outputGroup, ${inputs}), 0) - 127.0 / 255.0;
  result *= u_scale;
  if (u_activationWarp > 0.0001) {
    vec4 periodic = sin(result * u_warpFrequency);
    result = mix(result, periodic, u_activationWarp);
  }
  out_color = ${hiddenOutput ? "result / 2.0" : "encodeState(result)"};
}`;
}

const UPDATE = `${PREFIX}
uniform sampler2D u_state;
uniform sampler2D u_delta;
uniform sampler2D u_inverse;
uniform sampler2D u_barrier;
uniform ivec2 u_offset;
uniform float u_resonanceFeedback;
uniform float u_latentDecay;
uniform float u_noiseStrength;
uniform float u_latentMomentum;
uniform int u_stepSeed;

vec4 hashNoise(ivec2 p, int group, int seed) {
  uint h = uint(p.x * 374761393 + p.y * 668265263 + group * 381201580 + seed);
  h = (h ^ (h >> 13u)) * 1274126177u;
  uint h2 = h * 1597334673u + 3812015801u;
  return vec4(
    float(h & 0xffu) / 127.5 - 1.0,
    float((h >> 8u) & 0xffu) / 127.5 - 1.0,
    float((h >> 16u) & 0xffu) / 127.5 - 1.0,
    float((h2 >> 8u) & 0xffu) / 127.5 - 1.0
  );
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int group = p.x / u_size;
  ivec2 xy = ivec2(p.x % u_size, p.y);
  vec4 previous = texelFetch(u_state, p, 0);
  if (texelFetch(u_barrier, xy, 0).r > 0.5) {
    out_color = previous;
    return;
  }
  vec4 inverse = texelFetch(u_inverse, wrapCell(xy - u_offset), 0);
  if (inverse.b < 0.5) { out_color = previous; return; }
  int high = int(round(inverse.a * 255.0));
  int highX = high & 15;
  int highY = high >> 4;
  ivec2 compressed = ivec2(
    int(round(inverse.r * 255.0)) + highX * 256,
    int(round(inverse.g * 255.0)) + highY * 256
  );
  vec4 delta = decodeState(texelFetch(u_delta, ivec2(compressed.x + group * u_size, compressed.y), 0));
  if (group > 0 && u_noiseStrength > 0.0001) {
    delta += hashNoise(xy, group, u_stepSeed) * u_noiseStrength;
  }
  vec4 prevDecoded = decodeState(previous);
  vec4 targetState = prevDecoded + delta;
  if (group > 0 && u_latentMomentum > 0.0001) {
    targetState = mix(targetState, prevDecoded + delta * (1.0 - u_latentMomentum * 0.75), u_latentMomentum);
  }
  if (group > 0 && u_resonanceFeedback > 0.0001) {
    targetState = mix(targetState, prevDecoded * u_latentDecay, u_resonanceFeedback);
  }
  out_color = encodeState(clamp(targetState, -2.0, 2.0));
}`;

// Experimental passive transport. Every packed RGBA group uses the same
// departure point, so RGB and all nine hidden channels move together.
const ADVECTION = `${PREFIX}
uniform sampler2D u_state;
uniform sampler2D u_barrier;
uniform int u_flowField;
uniform float u_flowSpeed;
uniform float u_flowPhase;
uniform sampler2D u_velocity;
uniform int u_velocitySize;
vec2 motionAt(ivec2 p) {
  ivec2 wrapped = (p % u_velocitySize + u_velocitySize) % u_velocitySize;
  return texelFetch(u_velocity, wrapped, 0).rg;
}
vec4 sampleGroup(ivec2 cell, int group) {
  ivec2 wrapped = wrapCell(cell);
  return texelFetch(u_state, ivec2(wrapped.x + group * u_size, wrapped.y), 0);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int group = p.x / u_size;
  ivec2 xy = ivec2(p.x % u_size, p.y);
  if (texelFetch(u_barrier, xy, 0).r > 0.5) {
    out_color = texelFetch(u_state, p, 0);
    return;
  }
  vec2 angle = (vec2(xy) + 0.5) * (6.28318530718 / float(u_size)) + u_flowPhase;
  // Both fields are periodic and divergence-free in continuous space.
  vec2 velocity = u_flowField == 0
    ? vec2(sin(angle.y), 0.0)
    : vec2(sin(angle.x) * cos(angle.y), -cos(angle.x) * sin(angle.y));
  if (u_flowField == 2) {
    vec2 grid = vec2(xy) * float(u_velocitySize) / float(u_size);
    ivec2 node = ivec2(floor(grid));
    vec2 f = fract(grid);
    velocity = mix(mix(motionAt(node), motionAt(node + ivec2(1, 0)), f.x),
                   mix(motionAt(node + ivec2(0, 1)), motionAt(node + ivec2(1, 1)), f.x), f.y);
    velocity *= min(1.0, 0.05 / max(length(velocity), 1e-20));
  }
  vec2 departure = vec2(xy) - u_flowSpeed * velocity;
  ivec2 cell = ivec2(floor(departure));
  vec2 fraction = fract(departure);
  // Explicit group-local bilinear sampling prevents hidden/RGB band leakage
  // at the horizontal packing seams and wraps both spatial axes.
  vec4 lower = mix(sampleGroup(cell, group), sampleGroup(cell + ivec2(1, 0), group), fraction.x);
  vec4 upper = mix(sampleGroup(cell + ivec2(0, 1), group), sampleGroup(cell + ivec2(1, 1), group), fraction.x);
  out_color = mix(lower, upper, fraction.y);
}`;

const BARRIER_PASS = `${PREFIX}
uniform sampler2D u_barrier;
uniform ivec2 u_center;
uniform float u_radius;
uniform int u_barrierMode;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 distance = vec2(abs(p - u_center));
  distance = min(distance, vec2(float(u_size)) - distance);
  float dist = length(distance);
  float current = texelFetch(u_barrier, p, 0).r;
  if (dist <= u_radius) {
    float target = u_barrierMode == 1 ? 1.0 : 0.0;
    out_color = vec4(target, 0.0, 0.0, 1.0);
  } else {
    out_color = vec4(current, 0.0, 0.0, 1.0);
  }
}`;

const ORIENTATION_PASS = `${PREFIX}
uniform sampler2D u_orientation;
uniform ivec2 u_center;
uniform float u_radius;
uniform float u_strokeAngle;
uniform int u_orientMode;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 distance = vec2(abs(p - u_center));
  distance = min(distance, vec2(float(u_size)) - distance);
  float dist = length(distance);
  vec4 current = texelFetch(u_orientation, p, 0);
  if (dist <= u_radius) {
    float weight = smoothstep(u_radius, u_radius * 0.25, dist);
    if (u_orientMode == 1) {
      vec2 targetDir = vec2(cos(u_strokeAngle), sin(u_strokeAngle));
      vec2 existingDir = current.b > 0.05 ? (current.rg * 2.0 - 1.0) : targetDir;
      vec2 blended = normalize(mix(existingDir, targetDir, weight * 0.85));
      float newStrength = min(1.0, current.b + weight * 0.85);
      out_color = vec4(blended * 0.5 + 0.5, newStrength, 1.0);
    } else {
      out_color = mix(current, vec4(0.5, 0.5, 0.0, 0.0), weight);
    }
  } else {
    out_color = current;
  }
}
`;

const DISTURB = `${PREFIX}
uniform sampler2D u_state;
uniform sampler2D u_barrier;
uniform sampler2D u_intent;
uniform int u_hasIntent;
uniform ivec2 u_center;
uniform float u_radius;
uniform float u_strength;
uniform int u_mode;
uniform vec3 u_dyeColor;
uniform int u_explicitDye;
uniform int u_automatic;
uniform float u_quantizationPhase;
uniform int u_lockBarrier;
vec3 rgbToHsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsvToRgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int group = p.x / u_size;
  ivec2 xy = ivec2(p.x % u_size, p.y);
  vec2 delta = vec2(xy - u_center);
  delta = delta - round(delta / float(u_size)) * float(u_size);
  float dist = length(delta);
  float weight = 0.0;
  if (u_automatic == 1) {
    weight = (1.0 - smoothstep(u_radius * 0.35, u_radius, dist)) * clamp(u_strength, 0.0, 1.0);
  } else if (u_mode == 5 || u_mode == 6 || u_mode == 7 || u_mode == 8) {
    float angle = atan(delta.y, delta.x);
    float rMod = u_radius * (1.0 + 0.22 * cos(3.0 * angle + 1.25) + 0.12 * sin(5.0 * angle));
    if (dist <= rMod) {
      float sigma = max(2.0, rMod * 0.45);
      weight = exp(-(dist * dist) / (2.0 * sigma * sigma)) * u_strength;
    }
  } else if (dist <= u_radius) {
    weight = smoothstep(u_radius, u_radius * 0.35, dist);
  }
  if (weight <= 0.0 || (u_automatic == 0 && weight < 0.001)) {
    out_color = texelFetch(u_state, p, 0);
    return;
  }
  if (u_lockBarrier == 1 && texelFetch(u_barrier, xy, 0).r > 0.5) {
    out_color = texelFetch(u_state, p, 0);
    return;
  }
  if (u_automatic == 1 && u_hasIntent == 1 && texelFetch(u_intent, xy * ${INTENT_SIZE} / u_size, 0).r > 0.5) {
    out_color = texelFetch(u_state, p, 0);
    return;
  }
  vec4 current = texelFetch(u_state, p, 0);
  if (u_mode == 1) {
    vec2 coord = vec2(p);
    float n1 = fract(sin(dot(coord, vec2(12.9898, 78.233))) * 43758.5453);
    float n2 = fract(sin(dot(coord + vec2(17.1, 41.3), vec2(39.346, 11.135))) * 23421.631);
    float n3 = fract(sin(dot(coord + vec2(73.5, 91.2), vec2(73.156, 52.235))) * 84621.157);
    float n4 = fract(sin(dot(coord + vec2(103.7, 15.8), vec2(91.732, 29.412))) * 19283.472);
    vec4 target = vec4(n1, n2, n3, n4);
    out_color = mix(current, target, weight);
  } else if (u_mode == 2) {
    if (group == 0) {
      vec4 targetState = encodeState(vec4((u_dyeColor - 0.5) * 2.0, 1.0));
      out_color = mix(current, targetState, weight);
    } else {
      out_color = current;
    }
  } else if (u_mode == 5) {
    if (group == 0) {
      ivec2 centerCoord = ivec2(wrapCell(u_center));
      vec4 centerRaw = texelFetch(u_state, centerCoord, 0);
      vec3 bgRgb = clamp(decodeState(centerRaw).rgb * 0.5 + 0.5, 0.0, 1.0);
      vec3 bgHsv = rgbToHsv(bgRgb);
      vec3 standoutRgb;
      if (bgHsv.y < 0.18) {
        standoutRgb = bgHsv.z < 0.5 ? vec3(0.0, 0.94, 1.0) : vec3(1.0, 0.0, 0.65);
      } else {
        float targetHue = fract(bgHsv.x + 0.5);
        float targetVal = bgHsv.z < 0.5 ? 0.95 : 0.45;
        standoutRgb = hsvToRgb(vec3(targetHue, 0.95, targetVal));
      }
      if (u_explicitDye == 1) standoutRgb = u_dyeColor;
      vec4 targetState = encodeState(vec4((standoutRgb - 0.5) * 2.0, 1.0));
      out_color = mix(current, targetState, weight);

    } else {
      out_color = current;
    }
  } else if (u_mode == 6) {
    if (group <= 1) {
      vec2 sCoord = vec2(xy) * 0.06;
      float sn1 = sin(sCoord.x * 3.14 + sCoord.y * 1.7) * cos(sCoord.x * 1.3 - sCoord.y * 2.8);
      float sn2 = sin((sCoord.x + 4.2) * 2.1) * cos((sCoord.y + 1.8) * 2.4);
      float sn3 = cos((sCoord.x - 2.1) * 2.7) * sin((sCoord.y - 3.4) * 1.9);
      float sn4 = sin((sCoord.x + 7.5) * 1.8 + (sCoord.y - 5.1) * 2.2);
      vec4 perturb = vec4(sn1, sn2, sn3, sn4) * 0.15;
      out_color = clamp(current + perturb * weight, 0.0, 1.0);
    } else {
      out_color = current;
    }
  } else if (u_mode == 7) {
    if (group >= 1) {
      vec2 sCoord = vec2(xy) * 0.08;
      float sn1 = sin(sCoord.x * 3.14 + sCoord.y * 1.7) * cos(sCoord.x * 1.3 - sCoord.y * 2.8);
      float sn2 = sin((sCoord.x + 4.2) * 2.1) * cos((sCoord.y + 1.8) * 2.4);
      float sn3 = cos((sCoord.x - 2.1) * 2.7) * sin((sCoord.y - 3.4) * 1.9);
      float sn4 = sin((sCoord.x + 7.5) * 1.8 + (sCoord.y - 5.1) * 2.2);
      vec4 perturb = vec4(sn1, sn2, sn3, sn4) * 0.08;
      out_color = clamp(current + perturb * weight, 0.0, 1.0);
    } else {
      out_color = current;
    }
  } else if (u_mode == 8) {
    if (group >= 1) {
      out_color = mix(current, vec4(0.5, 0.5, 0.5, 0.5), clamp(weight * 0.65, 0.0, 1.0));
    } else {
      out_color = current;
    }
  } else if (u_mode == 4) {
    if (group == 0) {
      vec4 decoded = decodeState(current);
      vec3 invertedRgb = 1.0 - (decoded.rgb * 0.5 + 0.5);
      vec4 targetState = encodeState(vec4((invertedRgb - 0.5) * 2.0, decoded.a));
      out_color = mix(current, targetState, weight);
    } else {
      out_color = current;
    }
  } else {
    out_color = mix(current, vec4(127.0 / 255.0), weight);
  }
  if (u_automatic == 1) {
    // Unbiased RGBA8 rounding, decorrelated across pixels/channels and time.
    // Never increase the requested mixing weight just to cross one byte.
    vec4 seed = vec4(dot(vec2(xy), vec2(12.9898, 78.233))) + vec4(0.0, 17.1, 41.3, 73.5);
    vec4 threshold = fract(sin(seed) * 43758.5453 + u_quantizationPhase * 0.61803398875);
    vec4 rounded = floor(clamp(out_color, 0.0, 1.0) * 255.0 + threshold) / 255.0;
    out_color = mix(current, rounded, notEqual(out_color, current));
  }

}`;

const VISUALIZE = `${PREFIX}
uniform sampler2D u_state;
uniform sampler2D u_barrier;
uniform int u_palette;
uniform float u_palettePhase;
uniform int u_showBarrier;
uniform int u_rippleCount;
uniform vec4 u_ripple0;
uniform vec4 u_ripple1;
uniform vec4 u_ripple2;
uniform vec4 u_ripple3;
uniform vec4 u_rippleAmps;
uniform int u_channelView;
uniform ivec2 u_viewport;
uniform float u_zoom;
uniform vec2 u_pan;
uniform int u_displayFilter;

vec2 computeRippleDisplacement(vec2 pos, vec4 rippleData, float amplitude) {
  if (rippleData.z <= 0.0 || rippleData.z >= 1.0) return vec2(0.0);
  vec2 origin = rippleData.xy;
  float progress = rippleData.z;
  float maxRadius = rippleData.w;
  vec2 delta = pos - origin;
  delta -= floor(delta / float(u_size) + 0.5) * float(u_size);
  float dist = length(delta);
  float currentRadius = progress * maxRadius;
  float diff = dist - currentRadius;
  float waveWidth = max(8.0, maxRadius * 0.12);
  float spatialEnv = exp(-(diff * diff) / (2.0 * waveWidth * waveWidth));
  float timeFade = 1.0 - progress;
  timeFade = timeFade * timeFade;
  float wave = sin(diff * (3.14159265 / waveWidth));
  wave = wave * spatialEnv * timeFade * amplitude;
  vec2 dir = dist > 0.5 ? delta / dist : vec2(0.0);
  return dir * wave;
}

vec3 hueShift(vec3 color, float angle) {
  if (abs(angle) < 0.0001) return color;
  const vec3 k = vec3(0.577350269);
  float cosA = cos(angle);
  return color * cosA + cross(k, color) * sin(angle) + k * dot(k, color) * (1.0 - cosA);
}

vec4 sampleNearest(vec2 pos, int groupIdx) {
  int xOff = groupIdx * u_size;
  ivec2 cell = wrapCell(ivec2(floor(pos)));
  return decodeState(texelFetch(u_state, ivec2(cell.x + xOff, cell.y), 0));
}

vec4 sampleBicubic(vec2 pos, int groupIdx) {
  int xOff = groupIdx * u_size;
  vec2 p = pos - 0.5;
  ivec2 i0 = ivec2(floor(p));
  vec2 f = fract(p);
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec4 wx = vec4(
    -0.5 * f3.x + f2.x - 0.5 * f.x,
     1.5 * f3.x - 2.5 * f2.x + 1.0,
    -1.5 * f3.x + 2.0 * f2.x + 0.5 * f.x,
     0.5 * f3.x - 0.5 * f2.x
  );
  vec4 wy = vec4(
    -0.5 * f3.y + f2.y - 0.5 * f.y,
     1.5 * f3.y - 2.5 * f2.y + 1.0,
    -1.5 * f3.y + 2.0 * f2.y + 0.5 * f.y,
     0.5 * f3.y - 0.5 * f2.y
  );
  int x1 = (i0.x % u_size + u_size) % u_size;
  int x0 = (x1 - 1 + u_size) % u_size;
  int x2 = (x1 + 1) % u_size;
  int x3 = (x1 + 2) % u_size;

  int y1 = (i0.y % u_size + u_size) % u_size;
  int y0 = (y1 - 1 + u_size) % u_size;
  int y2 = (y1 + 1) % u_size;
  int y3 = (y1 + 2) % u_size;

  vec4 col0 = wx.x * texelFetch(u_state, ivec2(x0 + xOff, y0), 0) +
              wx.y * texelFetch(u_state, ivec2(x1 + xOff, y0), 0) +
              wx.z * texelFetch(u_state, ivec2(x2 + xOff, y0), 0) +
              wx.w * texelFetch(u_state, ivec2(x3 + xOff, y0), 0);

  vec4 col1 = wx.x * texelFetch(u_state, ivec2(x0 + xOff, y1), 0) +
              wx.y * texelFetch(u_state, ivec2(x1 + xOff, y1), 0) +
              wx.z * texelFetch(u_state, ivec2(x2 + xOff, y1), 0) +
              wx.w * texelFetch(u_state, ivec2(x3 + xOff, y1), 0);

  vec4 col2 = wx.x * texelFetch(u_state, ivec2(x0 + xOff, y2), 0) +
              wx.y * texelFetch(u_state, ivec2(x1 + xOff, y2), 0) +
              wx.z * texelFetch(u_state, ivec2(x2 + xOff, y2), 0) +
              wx.w * texelFetch(u_state, ivec2(x3 + xOff, y2), 0);

  vec4 col3 = wx.x * texelFetch(u_state, ivec2(x0 + xOff, y3), 0) +
              wx.y * texelFetch(u_state, ivec2(x1 + xOff, y3), 0) +
              wx.z * texelFetch(u_state, ivec2(x2 + xOff, y3), 0) +
              wx.w * texelFetch(u_state, ivec2(x3 + xOff, y3), 0);

  vec4 result = decodeState(wy.x * col0 + wy.y * col1 + wy.z * col2 + wy.w * col3);
  return clamp(result, vec4(-2.0), vec4(2.0));
}

vec4 sampleGroup(vec2 pos, int groupIdx) {
  if (u_displayFilter == 1) {
    return sampleNearest(pos, groupIdx);
  }
  return sampleBicubic(pos, groupIdx);
}

vec3 sampleRawColor(vec2 p) {
  if (u_channelView == 0) {
    return sampleGroup(p, 0).rgb * 0.5 + 0.5;
  } else if (u_channelView == 1) {
    float alpha = clamp(sampleGroup(p, 0).a * 0.5 + 0.5, 0.0, 1.0);
    return vec3(alpha);
  } else if (u_channelView == 2) {
    return clamp(sampleGroup(p, 1).rgb * 0.5 + 0.5, 0.0, 1.0);
  } else if (u_channelView == 3) {
    return clamp(sampleGroup(p, 2).rgb * 0.5 + 0.5, 0.0, 1.0);
  } else if (u_channelView == 4) {
    vec4 g1 = sampleGroup(p, 1);
    vec4 g2 = sampleGroup(p, 2);
    float eVal = length(g1) + length(g2);
    float normE = clamp(eVal * 0.22, 0.0, 1.0);
    if (normE < 0.35) {
      return mix(vec3(0.02, 0.04, 0.18), vec3(0.0, 0.92, 1.0), normE / 0.35);
    } else if (normE < 0.70) {
      return mix(vec3(0.0, 0.92, 1.0), vec3(1.0, 0.72, 0.0), (normE - 0.35) / 0.35);
    } else {
      return mix(vec3(1.0, 0.72, 0.0), vec3(1.0, 0.15, 0.75), (normE - 0.70) / 0.30);
    }
  } else {
    vec3 baseRgb = sampleGroup(p, 0).rgb * 0.5 + 0.5;
    vec4 g1 = sampleGroup(p, 1);
    vec4 g2 = sampleGroup(p, 2);
    float eVal = length(g1) + length(g2);
    float glow = clamp(eVal * 0.20, 0.0, 1.0);
    vec3 neuralGlow = mix(vec3(0.0, 0.95, 1.0), vec3(1.0, 0.0, 0.7), glow) * glow * 0.85;
    return clamp(baseRgb * 0.65 + neuralGlow, 0.0, 1.0);
  }
}

void main() {
  vec2 vpSize = u_viewport.x > 0 && u_viewport.y > 0 ? vec2(u_viewport) : vec2(float(u_size));
  float minDim = max(1.0, min(vpSize.x, vpSize.y));
  vec2 centered = (gl_FragCoord.xy - 0.5 * vpSize) / minDim;
  float z = u_zoom > 0.0 ? u_zoom : 1.0;
  float srcExtent = float(u_size) / z;
  vec2 pos = (0.5 + u_pan) * float(u_size) + centered * srcExtent;
  pos = mod(pos, float(u_size));

  vec2 disp = vec2(0.0);
  if (u_rippleCount > 0) disp += computeRippleDisplacement(pos, u_ripple0, u_rippleAmps.x);
  if (u_rippleCount > 1) disp += computeRippleDisplacement(pos, u_ripple1, u_rippleAmps.y);
  if (u_rippleCount > 2) disp += computeRippleDisplacement(pos, u_ripple2, u_rippleAmps.z);
  if (u_rippleCount > 3) disp += computeRippleDisplacement(pos, u_ripple3, u_rippleAmps.w);
  float dispLen = length(disp);
  if (dispLen > 1.8) {
    disp = (disp / dispLen) * 1.8;
  }
  vec3 rawRgb = sampleRawColor(pos - disp);

  // Soft highlight compression: smoothly rolls off intense highlights above 0.5
  vec3 rgb = rawRgb / (1.0 + max(vec3(0.0), rawRgb - 0.5) * 0.85);
  rgb = clamp(rgb, 0.0, 1.0);

  float lum = dot(rgb, vec3(0.299, 0.587, 0.114));

  if (u_channelView == 0) {
    if (u_palette == 0) {
      rgb = hueShift(rgb, u_palettePhase);
    } else {
      float phaseNorm = mod(u_palettePhase, 6.283185307) / 6.283185307;
      vec3 a = vec3(0.5);
      vec3 b = vec3(0.5);
      vec3 c = vec3(1.0);
      vec3 d = vec3(0.0, 0.33, 0.67);
      if (u_palette == 2) {
        c = vec3(2.0, 1.0, 0.5);
        d = vec3(0.5, 0.20, 0.25);
      } else if (u_palette == 3) {
        a = vec3(0.8, 0.5, 0.4);
        b = vec3(0.2, 0.4, 0.2);
        c = vec3(2.0, 1.0, 1.0);
        d = vec3(0.0, 0.25, 0.25);
      } else if (u_palette == 4) {
        d = vec3(0.3, 0.20, 0.80);
      } else if (u_palette == 5) {
        c = vec3(1.0, 1.0, 0.5);
        d = vec3(0.8, 0.90, 0.30);
      }
      vec3 spectrum = a + b * cos(6.283185307 * (c * (lum * 0.85) + d + phaseNorm));
      rgb = spectrum * (0.35 + lum * 0.65);
    }
  }

  if (u_showBarrier == 1) {
    ivec2 bCoord = wrapCell(ivec2(floor(pos)));
    float bL = texelFetch(u_barrier, wrapCell(bCoord + ivec2(-1, 0)), 0).r;
    float bR = texelFetch(u_barrier, wrapCell(bCoord + ivec2(1, 0)), 0).r;
    float bD = texelFetch(u_barrier, wrapCell(bCoord + ivec2(0, -1)), 0).r;
    float bU = texelFetch(u_barrier, wrapCell(bCoord + ivec2(0, 1)), 0).r;
    float bEdge = max(abs(bR - bL), abs(bU - bD));
    if (bEdge > 0.2) {
      bool dash = mod(float(bCoord.x + bCoord.y), 8.0) < 4.0;
      if (dash) {
        rgb = mix(rgb, vec3(1.0) - rgb, 0.85);
      }
    }
  }

  out_color = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

const ECHO_PASS = `${PREFIX}
in vec2 v_uv;
uniform sampler2D u_current;
uniform sampler2D u_history;
uniform ivec2 u_viewport;
uniform ivec2 u_historyViewport;
uniform float u_historyAspect;
uniform float u_decay;
uniform float u_drift;
uniform int u_mode;
uniform int u_style;
uniform int u_transform;
uniform float u_twist;
uniform float u_angle;
uniform float u_geometryStrength;
uniform float u_geometryCenterX;
uniform float u_geometryCenterY;
uniform float u_geometrySoftness;
uniform float u_foldCount;
uniform float u_zoom;
uniform vec2 u_pan;

float wrapEchoAxis(float u, float period, float halfTexel) {
  if (abs(period - 1.0) <= 0.001) return fract(u);
  if (u >= halfTexel && u <= 1.0 - halfTexel) return u;
  if (period < 1.0) {
    if (u < halfTexel) {
      return clamp(u + ceil((halfTexel - u) / period) * period, halfTexel, 1.0 - halfTexel);
    }
    return clamp(u - ceil((u - (1.0 - halfTexel)) / period) * period, halfTexel, 1.0 - halfTexel);
  }
  return clamp(u, halfTexel, 1.0 - halfTexel);
}

vec2 wrapEchoUv(vec2 uv, vec2 period, vec2 histSize) {
  vec2 halfTexel = 0.5 / max(histSize, vec2(1.0));
  return vec2(
    wrapEchoAxis(uv.x, period.x, halfTexel.x),
    wrapEchoAxis(uv.y, period.y, halfTexel.y)
  );
}

void main() {
  float zoom = max(u_zoom, 1.0);
  vec2 vpSize = u_viewport.x > 0 && u_viewport.y > 0 ? vec2(u_viewport) : vec2(float(u_size));
  float minDim = max(1.0, min(vpSize.x, vpSize.y));
  vec2 aspectVec = vpSize / minDim;
  vec2 centered = (v_uv - 0.5) * aspectVec;
  vec2 world = fract(0.5 + centered / zoom + u_pan);
  vec2 pos = world * 2.0 - 1.0 - vec2(u_geometryCenterX, u_geometryCenterY);
  float r = length(pos);
  float phi = atan(pos.y, pos.x);

  vec2 driftDir = vec2(cos(u_angle), sin(u_angle));
  if (u_mode == 0) {
    float theta = u_angle;
    if (u_transform == 1) {
      theta = phi + 1.5707963 + u_twist + u_angle;
    } else if (u_transform == 2) {
      float r_eff = sqrt(r * r + 0.0001 + u_geometrySoftness * 0.15);
      float pitch = clamp(u_twist, -${SPIRAL_MAX_PITCH_RADIANS}, ${SPIRAL_MAX_PITCH_RADIANS});
      theta = phi + 1.5707963 + log(max(r_eff, 0.01)) * tan(pitch) + u_angle;
    } else if (u_transform == 3) {
      vec2 z = pos * 1.25;
      vec2 c = vec2(-0.8, 0.156);
      for (int i = 0; i < 5; i++) {
        z = vec2(z.x * z.x - z.y * z.y + c.x, 2.0 * z.x * z.y + c.y);
      }
      theta = atan(z.y, z.x) + u_twist + u_angle;
    } else if (u_transform == 4) {
      vec2 p1 = pos - vec2(-0.45, 0.0);
      vec2 p2 = pos - vec2(0.45, 0.0);
      float d1 = dot(p1, p1) + 0.01 + u_geometrySoftness * 0.15;
      float d2 = dot(p2, p2) + 0.01 + u_geometrySoftness * 0.15;
      vec2 flow = vec2(-p1.y / d1 - p2.y / d2, p1.x / d1 + p2.x / d2);
      theta = atan(flow.y, flow.x) + u_twist + u_angle;
    } else if (u_transform == 5) {
      float waveFreq = 6.2831853;
      float wavePhase = pos.y * waveFreq + pos.x * sin(u_twist) * 3.14159 + u_angle;
      float waveOffset = sin(wavePhase) * (0.85 + abs(u_twist) * 0.5);
      theta = u_angle + waveOffset + u_twist;
    } else if (u_transform == 6) {
      float saddleAngle = atan(-pos.y, pos.x);
      theta = saddleAngle + u_twist + u_angle;
    } else if (u_transform == 7) {
      float folds = clamp(u_foldCount, 3.0, 12.0);
      float sectorAngle = 6.2831853 / folds;
      float halfSector = sectorAngle * 0.5;
      float phiNorm = mod(phi + 3.14159265, 6.2831853);
      float inSector = mod(phiNorm, sectorAngle);
      float folded = abs(inSector - halfSector);
      float petalAngle = (phiNorm - inSector) + (folded < halfSector * 0.5 ? folded : (halfSector - folded)) * 2.0;
      theta = petalAngle + 1.5707963 + u_twist + u_angle;
    } else if (u_transform == 8) {
      float spacing = mix(0.25, 0.65, clamp(u_geometrySoftness * 1.5, 0.0, 1.0));
      vec2 p1 = pos - vec2(-spacing, 0.0);
      vec2 p2 = pos - vec2(spacing, 0.0);
      float d1 = dot(p1, p1) + 0.01 + u_geometrySoftness * 0.15;
      float d2 = dot(p2, p2) + 0.01 + u_geometrySoftness * 0.15;
      float twistMag = abs(u_twist);
      float w1 = 1.0;
      float spinSign = u_twist < -0.01 ? -1.0 : 1.0;
      float w2 = spinSign * max(0.2, 1.0 - twistMag * 0.45);
      vec2 flow = vec2(-w1 * p1.y / d1 - w2 * p2.y / d2, w1 * p1.x / d1 + w2 * p2.x / d2);
      theta = atan(flow.y, flow.x) + u_angle;
    } else if (u_transform == 9) {
      float cellScale = mix(2.2, 4.2, u_geometrySoftness);
      vec2 gridCoord = pos * cellScale;
      vec2 i_coord = floor(gridCoord);
      vec2 f_coord = fract(gridCoord);
      vec2 minDiff = vec2(0.0);
      vec2 secondDiff = vec2(0.0);
      float minDist = 10.0;
      float secondMinDist = 10.0;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec2 neighbor = vec2(float(x), float(y));
          vec2 p = i_coord + neighbor;
          vec2 seed = 0.5 + 0.38 * sin(vec2(
            dot(p, vec2(127.1, 311.7)),
            dot(p, vec2(269.5, 183.3))
          ));
          vec2 diff = neighbor + seed - f_coord;
          float dist = dot(diff, diff);
          if (dist < minDist) {
            secondMinDist = minDist;
            secondDiff = minDiff;
            minDist = dist;
            minDiff = diff;
          } else if (dist < secondMinDist) {
            secondMinDist = dist;
            secondDiff = diff;
          }
        }
      }
      float d1 = sqrt(minDist);
      float d2 = sqrt(secondMinDist);
      float wallDist = max(0.0001, d2 - d1);
      vec2 safeMinDiff = length(minDiff) < 0.0001 ? vec2(0.0001, 0.0) : minDiff;
      float islandCircAngle = atan(safeMinDiff.y, safeMinDiff.x) + 1.5707963;
      vec2 wallVec = vec2(-(secondDiff.y - minDiff.y), secondDiff.x - minDiff.x);
      float wallAngle = atan(wallVec.y, wallVec.x);
      float wallBaseWeight = smoothstep(mix(0.35, 0.6, u_geometrySoftness), 0.02, wallDist);
      float wallWeight = clamp(wallBaseWeight * (1.0 - clamp(u_twist * 0.8, -0.6, 0.6)), 0.0, 1.0);
      float radialBlend = clamp(u_twist * 0.7, -1.0, 1.0);
      vec2 vIsland = vec2(cos(islandCircAngle), sin(islandCircAngle));
      vec2 vWall = vec2(cos(wallAngle), sin(wallAngle));
      vec2 vCell = mix(vIsland, vWall, wallWeight);
      float baseAngle = length(vCell) > 0.0001 ? atan(vCell.y, vCell.x) : islandCircAngle;
      theta = baseAngle + radialBlend * 1.5707963 + u_angle;
    }
    vec2 vBase = vec2(cos(u_angle), sin(u_angle));
    vec2 vTrans = vec2(cos(theta), sin(theta));
    vec2 vBlend = mix(vBase, vTrans, clamp(u_geometryStrength, 0.0, 1.0));
    driftDir = length(vBlend) > 0.0001 ? normalize(vBlend) : vBase;
  } else if (u_mode == 1) {
    driftDir = r > 0.001 ? normalize(pos) : vec2(0.0);
  } else {
    driftDir = vec2(cos(u_angle), sin(u_angle));
  }

  float stepLen = u_drift * 0.006 * zoom;
  vec2 histSize = u_historyViewport.x > 0 && u_historyViewport.y > 0 ? vec2(u_historyViewport) : vpSize;
  float histRatio = u_historyAspect > 0.0 ? u_historyAspect : (histSize.x / max(1.0, histSize.y));
  vec2 histAspectVec = histRatio >= 1.0 ? vec2(histRatio, 1.0) : vec2(1.0, 1.0 / histRatio);
  vec2 period = zoom / histAspectVec;
  vec2 uvStep = (driftDir * stepLen) / histAspectVec;
  vec2 baseHistUv = 0.5 + centered / histAspectVec;
  vec2 uv_r = wrapEchoUv(baseHistUv - uvStep * 1.05, period, histSize);
  vec2 uv_g = wrapEchoUv(baseHistUv - uvStep, period, histSize);
  vec2 uv_b = wrapEchoUv(baseHistUv - uvStep * 0.95, period, histSize);

  vec4 curr = texture(u_current, v_uv);
  vec3 prevRgb = vec3(
    texture(u_history, uv_r).r,
    texture(u_history, uv_g).g,
    texture(u_history, uv_b).b
  );

  vec3 blendedRgb = curr.rgb;
  if (u_style == 0) {
    blendedRgb = max(curr.rgb, prevRgb * u_decay);
  } else {
    blendedRgb = mix(prevRgb * u_decay, curr.rgb, max(0.05, 1.0 - u_decay));
  }

  out_color = vec4(clamp(blendedRgb, 0.0, 1.0), 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not allocate shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error("NCA shader compilation failed: " + error);
  }
  return shader;
}

function link(gl, source) {
  const shaders = [];
  let program;
  try {
    shaders.push(compile(gl, gl.VERTEX_SHADER, VERTEX));
    shaders.push(compile(gl, gl.FRAGMENT_SHADER, source));
    program = gl.createProgram();
    if (!program) throw new Error("Could not allocate program.");
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(
        "NCA shader linking failed: " + gl.getProgramInfoLog(program),
      );
    }
    return program;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}

export class TextureNcaRuntime {
  constructor({
    model,
    size = model?.startup?.gridSize ?? 256,
    seed = model?.startup?.seed ?? 1,
  }) {
    this.size = validateSize(size);
    this.seed = validateSeed(seed);
    if (
      !model ||
      !(model.layers?.[0]?.weights instanceof Uint8Array) ||
      !(model.layers?.[1]?.weights instanceof Uint8Array)
    ) {
      throw new Error(
        "Load a validated checkpoint before constructing the runtime.",
      );
    }
    this.model = model;
    this.steps = 0;
    this.generation = ++nextRuntimeGeneration;
    this._vitalityProbe = null;
    this._protectionTexture = null;
    this._protectionBytes = null;
    this.disposed = false;
    this.lost = false;
    this.textures = [];
    this.framebuffers = [];
    this.programs = [];
    this.textureBytes = 0;
    this.lastOffset = [0, 0];
    this.canvas = document.createElement("canvas");
    this.canvas.width = size;
    this.canvas.height = size;
    this.onContextLost = (event) => this.handleContextLoss(event);
    this.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    if (!this.gl) {
      this.dispose();
      throw new Error("Neural Growth requires WebGL2.");
    }
    try {
      const gl = this.gl;
      gl.disable(gl.BLEND);
      gl.disable(gl.DITHER);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      this.renderer = gl.getParameter(gl.RENDERER);
      this.vao = gl.createVertexArray();
      if (!this.vao) throw new Error("Could not allocate vertex array.");
      gl.bindVertexArray(this.vao);
      this.program = {};
      for (const [name, source] of Object.entries({
        perception: PERCEPTION,
        hidden: denseShader(48, false, true),
        delta: denseShader(96, true, false),
        update: UPDATE,
        disturb: DISTURB,
        barrier: BARRIER_PASS,
        orientation: ORIENTATION_PASS,
        visualize: VISUALIZE,
        echo: ECHO_PASS,
      })) {
        const handle = link(gl, source);
        this.programs.push(handle);
        this.program[name] = { handle, locations: new Map() };
      }
      this.echoTargets = null;
      this.currentFrameTarget = null;
      this.echoIndex = 0;
      this.state = this.allocate(size * 3, size, true);
      this.nextState = this.allocate(size * 3, size, true);
      this.perception = this.allocate(size * 6, size, true);
      this.hidden = this.allocate(size * 6, size * 2, true);
      this.delta = this.allocate(size * 3, size / 2, true);
      this.shuffleTexture = this.allocate(size, size / 2, false);
      this.inverseTexture = this.allocate(size, size, false);
      this.barrier = this.allocate(size, size, true);
      this.nextBarrier = this.allocate(size, size, true);
      this.orientation = this.allocate(size, size, true);
      this.nextOrientation = this.allocate(size, size, true);
      this.weights = model.layers.map((layer) =>
        this.allocate(layer.shape[1] / 4, layer.shape[0], false, layer.weights),
      );
      this.rotation = 0;
      this.topology = "square";
      this.coordinateTransform = "cartesian";
      this.twist = 0;
      this.foldCount = 6.0;
      this.latentMomentum = 0.0;
      this.geometryStrength = 1.0;
      this.geometryCenterX = 0.0;
      this.geometryCenterY = 0.0;
      this.geometrySoftness = 0.25;
      this.resonance = null;
      this._motionFieldTexture = null;
      this._motionFieldMax = 0;
      this.restart(seed);
      if (gl.getError() !== gl.NO_ERROR)
        throw new Error("WebGL initialization failed.");
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  assertActive() {
    if (this.disposed) throw new Error("The NCA runtime has been disposed.");
    if (this.lost || this.gl.isContextLost())
      throw new Error(
        "The WebGL context was lost. Reload the pattern to resume.",
      );
  }

  allocate(width, height, renderTarget, data = null) {
    const gl = this.gl;
    if (Math.max(width, height) > gl.getParameter(gl.MAX_TEXTURE_SIZE)) {
      throw new Error("The simulation exceeds this device's texture limit.");
    }
    const texture = gl.createTexture();
    if (!texture) throw new Error("Could not allocate texture.");
    this.textures.push(texture);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data,
    );
    let framebuffer = null;
    if (renderTarget) {
      framebuffer = gl.createFramebuffer();
      if (!framebuffer) throw new Error("Could not allocate framebuffer.");
      this.framebuffers.push(framebuffer);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        texture,
        0,
      );
      if (
        gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE
      ) {
        throw new Error("NCA framebuffer is incomplete.");
      }
    }
    this.textureBytes += width * height * 4;
    return { texture, framebuffer, width, height };
  }

  allocateEchoTarget(width, height) {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error("Could not allocate echo texture.");
    this.textures.push(texture);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new Error("Could not allocate echo framebuffer.");
    this.framebuffers.push(framebuffer);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.textureBytes += width * height * 4;
    return { texture, framebuffer, width, height };
  }

  releaseTarget(target) {
    if (!target) return;
    const textureIndex = this.textures.indexOf(target.texture);
    const framebufferIndex = this.framebuffers.indexOf(target.framebuffer);
    if (textureIndex !== -1) {
      this.gl.deleteTexture(target.texture);
      this.textures.splice(textureIndex, 1);
      this.textureBytes -= target.width * target.height * 4;
    }
    if (framebufferIndex !== -1) {
      this.gl.deleteFramebuffer(target.framebuffer);
      this.framebuffers.splice(framebufferIndex, 1);
    }
  }

  run(name, output, inputs = {}, uniforms = {}) {
    const gl = this.gl;
    const program = this.program[name];
    gl.bindFramebuffer(gl.FRAMEBUFFER, output?.framebuffer ?? null);
    gl.viewport(
      0,
      0,
      output?.width ?? this.canvas.width,
      output?.height ?? this.canvas.height,
    );
    gl.useProgram(program.handle);
    gl.bindVertexArray(this.vao);
    const location = (key) => {
      if (!program.locations.has(key)) {
        const value = gl.getUniformLocation(program.handle, key);
        program.locations.set(key, value);
      }
      return program.locations.get(key);
    };
    gl.uniform1i(location("u_size"), this.size);
    let unit = 0;
    for (const [key, buffer] of Object.entries(inputs)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, buffer.texture);
      gl.uniform1i(location(key), unit);
      unit += 1;
    }
    for (const [key, value] of Object.entries(uniforms)) {
      if (Array.isArray(value)) {
        if (value.length === 4)
          gl.uniform4f(location(key), value[0], value[1], value[2], value[3]);
        else if (value.length === 3)
          gl.uniform3f(location(key), value[0], value[1], value[2]);
        else if (key === "u_pan")
          gl.uniform2f(location(key), value[0], value[1]);
        else gl.uniform2i(location(key), value[0], value[1]);
      } else if (
        [
          "u_palette",
          "u_topology",
          "u_mode",
          "u_style",
          "u_transform",
          "u_barrierMode",
          "u_orientMode",
          "u_showBarrier",
          "u_lockBarrier",
          "u_hasHistory",
          "u_hasIntent",
          "u_explicitDye",
          "u_automatic",
          "u_rippleCount",
          "u_channelView",
          "u_displayFilter",
          "u_stepSeed",
          "u_flowField",
          "u_velocitySize",
        ].includes(key)
      )
        gl.uniform1i(location(key), value);
      else gl.uniform1f(location(key), value);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  restart(seed = this.seed) {
    this.assertActive();
    this.invalidateVitality();
    if (this._protectionTexture) this.setProtectionMask(new Uint8Array(INTENT_SIZE ** 2));
    this.seed = validateSeed(seed);
    this.layout = createSparseLayout(this.size, seed);
    this.lastOffset = [0, 0];
    const gl = this.gl;
    if (this.echoTargets) {
      for (const target of this.echoTargets) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    for (const [buffer, data] of [
      [this.shuffleTexture, this.layout.shuffle],
      [this.inverseTexture, this.layout.inverse],
    ]) {
      gl.bindTexture(gl.TEXTURE_2D, buffer.texture);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        buffer.width,
        buffer.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        data,
      );
    }
    for (const buffer of [
      this.barrier,
      this.nextBarrier,
      this.orientation,
      this.nextOrientation,
    ]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffer.framebuffer);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    if (this.model.startup?.seedState === "noise") {
      this.writeState(
        createInitialState(this.size, this.seed, this.model.startup),
      );
    } else {
      for (const buffer of [this.state, this.nextState]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, buffer.framebuffer);
        gl.clearColor(127 / 255, 127 / 255, 127 / 255, 127 / 255);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }
    this.clearMotionField();
    this.steps = 0;
  }

  step(
    count = 1,
    {
      rotation = this.rotation,
      topology = this.topology,
      coordinateTransform = this.coordinateTransform,
      twist = this.twist,
      geometryStrength = this.geometryStrength,
      geometryCenterX = this.geometryCenterX,
      geometryCenterY = this.geometryCenterY,
      geometrySoftness = this.geometrySoftness,
      resonance = this.resonance,
      foldCount = this.foldCount,
      latentMomentum = this.latentMomentum,
    } = {},
  ) {
    this.assertActive();
    this.rotation = Number(rotation) || 0;
    this.topology = topology === "hexagonal" ? "hexagonal" : "square";
    this.coordinateTransform = coordinateTransform || "cartesian";
    this.twist = clampGeometryTwist(this.coordinateTransform, twist);
    this.foldCount = Number.isFinite(Number(foldCount))
      ? Math.max(3.0, Math.min(12.0, Number(foldCount)))
      : 6.0;
    this.latentMomentum = Number.isFinite(Number(latentMomentum))
      ? Math.max(0.0, Math.min(0.9, Number(latentMomentum)))
      : 0.0;
    this.geometryStrength = clampGeometryStrength(geometryStrength);
    this.geometryCenterX = Number.isFinite(Number(geometryCenterX))
      ? Math.max(-1.0, Math.min(1.0, Number(geometryCenterX)))
      : 0.0;
    this.geometryCenterY = Number.isFinite(Number(geometryCenterY))
      ? Math.max(-1.0, Math.min(1.0, Number(geometryCenterY)))
      : 0.0;
    this.geometrySoftness = Number.isFinite(Number(geometrySoftness))
      ? Math.max(0.0, Math.min(1.0, Number(geometrySoftness)))
      : 0.25;
    if (resonance !== undefined) {
      this.resonance =
        resonance instanceof ResonanceConfig
          ? resonance
          : resonance
            ? new ResonanceConfig(resonance)
            : null;
    }
    if (!Number.isInteger(count) || count < 0 || count > 128)
      throw new RangeError("Step count must be between zero and 128.");
    const transformCode = TRANSFORM_CODES[this.coordinateTransform] ?? 0;
    for (let index = 0; index < count; index += 1) {
      this.lastOffset = [
        Math.floor(this.layout.random() * this.size),
        Math.floor(this.layout.random() * this.size),
      ];
      const resUniforms = this.resonance?.toUniforms(this.steps);
      this.run(
        "perception",
        this.perception,
        {
          u_state: this.state,
          u_shuffle: this.shuffleTexture,
          u_orientation: this.orientation,
        },
        {
          u_offset: this.lastOffset,
          u_angle: this.rotation,
          u_perceptionPhase: resUniforms?.perceptionPhase ?? 0.0,
          u_topology: this.topology === "hexagonal" ? 1 : 0,
          u_transform: transformCode,
          u_twist: this.twist,
          u_geometryStrength: this.geometryStrength,
          u_geometryCenterX: this.geometryCenterX,
          u_geometryCenterY: this.geometryCenterY,
          u_geometrySoftness: this.geometrySoftness,
          u_foldCount: this.foldCount,
        },
      );
      this.run(
        "hidden",
        this.hidden,
        { u_input: this.perception, u_weights: this.weights[0] },
        {
          u_scale: this.model.layers[0].scale,
          u_activationWarp: resUniforms?.activationWarp ?? 0.0,
          u_warpFrequency: resUniforms?.warpFrequency ?? 3.14159,
        },
      );
      this.run(
        "delta",
        this.delta,
        { u_input: this.hidden, u_weights: this.weights[1] },
        {
          u_scale: this.model.layers[1].scale,
          u_activationWarp: resUniforms?.activationWarp ?? 0.0,
          u_warpFrequency: resUniforms?.warpFrequency ?? 3.14159,
        },
      );
      this.run(
        "update",
        this.nextState,
        {
          u_state: this.state,
          u_delta: this.delta,
          u_inverse: this.inverseTexture,
          u_barrier: this.barrier,
        },
        {
          u_offset: this.lastOffset,
          u_resonanceFeedback: resUniforms?.latentFeedback ?? 0.0,
          u_latentDecay: resUniforms?.latentDecay ?? 1.0,
          u_noiseStrength: resUniforms?.noiseStrength ?? 0.0,
          u_latentMomentum: this.latentMomentum,
          u_stepSeed: resUniforms?.stepSeed ?? 0,
        },
      );
      [this.state, this.nextState] = [this.nextState, this.state];
      this.steps += 1;
    }
  }

  /**
   * One experimental transport pass, independent of the NCA update count.
   * Analytic speed and uploaded learned vectors use cells per pass. Call once
   * after each NCA step in the motion experiment; learned vectors are already
   * scaled and ignore the analytic speed multiplier.
   */
  advect({ field = "wave", speed = 0.05, phase = 0 } = {}) {
    this.assertActive();
    if (!["wave", "vortex", "learned"].includes(field))
      throw new RangeError("Flow must be wave, vortex, or learned.");
    if (!Number.isFinite(speed) || Math.abs(speed) > 1)
      throw new RangeError("Flow speed must be within one cell per pass.");
    if (!Number.isFinite(phase))
      throw new RangeError("Flow phase must be finite.");
    if (field === "learned" ? !this._motionFieldMax : speed === 0) return;
    if (!this.program.advection) {
      const handle = link(this.gl, ADVECTION);
      this.programs.push(handle);
      this.program.advection = { handle, locations: new Map() };
    }
    this.run(
      "advection",
      this.nextState,
      {
        u_state: this.state,
        u_barrier: this.barrier,
        u_velocity: this._motionFieldTexture || this.state,
      },
      {
        u_flowField: field === "learned" ? 2 : field === "vortex" ? 1 : 0,
        u_flowSpeed: field === "learned" ? 1 : speed,
        u_flowPhase: phase,
        u_velocitySize: MOTION_GRID_SIZE,
      },
    );
    [this.state, this.nextState] = [this.nextState, this.state];
  }

  setMotionField(values) {
    this.assertActive();
    const field = limitMotionField(values);
    const gl = this.gl;
    if (!this._motionFieldTexture) {
      const texture = gl.createTexture();
      if (!texture) throw new Error("Could not allocate the velocity field.");
      this.textures.push(texture);
      this._motionFieldTexture = {
        texture,
        width: MOTION_GRID_SIZE,
        height: MOTION_GRID_SIZE,
      };
      this.textureBytes += field.byteLength;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RG32F,
        MOTION_GRID_SIZE,
        MOTION_GRID_SIZE,
        0,
        gl.RG,
        gl.FLOAT,
        field,
      );
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this._motionFieldTexture.texture);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        MOTION_GRID_SIZE,
        MOTION_GRID_SIZE,
        gl.RG,
        gl.FLOAT,
        field,
      );
    }
    this._motionFieldMax = motionFieldStats(field).maxSpeed;
  }

  clearMotionField() {
    if (this._motionFieldTexture && !this.disposed && !this.gl.isContextLost())
      this.setMotionField(new Float32Array(MOTION_GRID_SIZE ** 2 * 2));
    this._motionFieldMax = 0;
  }

  disturb(
    x,
    y,
    radius = 8,
    mode = "erase",
    {
      dyeColor,
      automatic = false,
      quantizationPhase = 0,
      strokeAngle = 0,
      lockBarrier = true,
      strength = 1.0,
    } = {},
  ) {
    this.assertActive();
    if (!automatic) this.invalidateVitality();
    if (
      ![x, y, radius].every(Number.isFinite) ||
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      x >= this.size ||
      y < 0 ||
      y >= this.size ||
      radius <= 0 ||
      radius > this.size / 2
    ) {
      throw new RangeError("Disturbance must lie within the simulation grid.");
    }
    if (mode === "freeze") {
      this.run(
        "barrier",
        this.nextBarrier,
        { u_barrier: this.barrier },
        { u_center: [x, y], u_radius: radius, u_barrierMode: 1 },
      );
      [this.barrier, this.nextBarrier] = [this.nextBarrier, this.barrier];
      return;
    }
    if (mode === "thaw") {
      this.run(
        "barrier",
        this.nextBarrier,
        { u_barrier: this.barrier },
        { u_center: [x, y], u_radius: radius, u_barrierMode: 0 },
      );
      [this.barrier, this.nextBarrier] = [this.nextBarrier, this.barrier];
      return;
    }
    if (mode === "groom") {
      this.run(
        "orientation",
        this.nextOrientation,
        { u_orientation: this.orientation },
        {
          u_center: [x, y],
          u_radius: radius,
          u_strokeAngle: strokeAngle,
          u_orientMode: 1,
        },
      );
      [this.orientation, this.nextOrientation] = [
        this.nextOrientation,
        this.orientation,
      ];
      return;
    }
    if (mode === "erase") {
      this.run(
        "barrier",
        this.nextBarrier,
        { u_barrier: this.barrier },
        { u_center: [x, y], u_radius: radius, u_barrierMode: 0 },
      );
      [this.barrier, this.nextBarrier] = [this.nextBarrier, this.barrier];
      this.run(
        "orientation",
        this.nextOrientation,
        { u_orientation: this.orientation },
        {
          u_center: [x, y],
          u_radius: radius,
          u_strokeAngle: 0,
          u_orientMode: 0,
        },
      );
      [this.orientation, this.nextOrientation] = [
        this.nextOrientation,
        this.orientation,
      ];
    }
    let modeCode = 0;
    let effectiveStrength = Number.isFinite(Number(strength))
      ? Math.max(0, Number(strength))
      : 1.0;
    let effectiveRadius = radius;
    if (mode === "noise") modeCode = 1;
    else if (mode === "dye") modeCode = 2;
    else if (mode === "invert") modeCode = 4;
    else if (mode === "shockwave") {
      modeCode = 5;
      effectiveRadius = Math.min(
        12,
        Math.max(6, Math.round(this.size * 0.05)),
      );
      effectiveStrength = 0.18;
    } else if (mode === "kick_color") modeCode = 5;
    else if (mode === "kick_perturb") modeCode = 6;
    else if (mode === "kick_hidden_perturb" || mode === "infuse") modeCode = 7;
    else if (mode === "kick_hidden_prune" || mode === "prune") modeCode = 8;
    this.run(
      "disturb",
      this.nextState,
      { u_state: this.state, u_barrier: this.barrier, u_intent: this._protectionTexture || this.barrier },
      {
        u_hasIntent: this._protectionTexture ? 1 : 0,
        u_center: [x, y],
        u_radius: effectiveRadius,
        u_strength: effectiveStrength,
        u_mode: modeCode,
        u_dyeColor: Array.isArray(dyeColor) ? dyeColor : [0, 0.94, 1],
        u_explicitDye: Array.isArray(dyeColor) ? 1 : 0,
        u_automatic: automatic ? 1 : 0,
        u_quantizationPhase: quantizationPhase % 4096,
        u_lockBarrier: automatic || lockBarrier ? 1 : 0,
      },
    );
    [this.state, this.nextState] = [this.nextState, this.state];
  }

  clearBarrier() {
    this.assertActive();
    this.invalidateVitality();
    const gl = this.gl;
    for (const buffer of [this.barrier, this.nextBarrier]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffer.framebuffer);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  draw(targetCanvas, optionsOrPalette = "native", zoomArg = 1) {
    this.assertActive();
    const options =
      typeof optionsOrPalette === "object" && optionsOrPalette !== null
        ? optionsOrPalette
        : { palette: optionsOrPalette, zoom: zoomArg };

    const {
      palette = "native",
      palettePhase = 0,
      zoom = 1,
      pan = [0, 0],
      displayFilter = "smooth",
      showBarrier = false,
      ripples = [],
      channelView = "phenotype",
      echoDecay = 0.0,
      echoDrift = 0.25,
      echoMode = "field_advection",
      echoStyle = "phosphor",
      preserveEchoHistory = false,
    } = options;

    const decay = Math.max(0.0, Math.min(0.98, Number(echoDecay) || 0.0));
    const drift = Math.max(-1.0, Math.min(1.0, Number(echoDrift) || 0.0));
    const echoModes = { field_advection: 0, radial_bloom: 1, linear_drift: 2 };
    const echoModeCode = echoModes[echoMode] ?? 0;
    const echoStyles = { phosphor: 0, mist: 1 };
    const echoStyleCode = echoStyles[echoStyle] ?? 0;

    const paletteModes = {
      native: 0,
      spectral: 1,
      thermal: 2,
      neon: 3,
      ocean: 4,
      verdant: 5,
    };
    if (!Object.prototype.hasOwnProperty.call(paletteModes, palette))
      throw new Error("Unknown display palette.");
    const paletteCode = paletteModes[palette];
    const palettePhaseRad = Number(palettePhase) || 0.0;
    const context = targetCanvas.getContext("2d");
    if (!context) throw new Error("A 2D display canvas is required.");

    const channelViewModes = {
      phenotype: 0,
      vitality: 1,
      fast_signals: 2,
      memory_waves: 3,
      energy_heat: 4,
      xray: 5,
    };
    const channelViewCode = channelViewModes[channelView] ?? 0;

    const activeRipples = Array.isArray(ripples) ? ripples.slice(0, 4) : [];
    const rippleCount = activeRipples.length;
    const now = performance.now();
    const rippleUniforms = {
      u_rippleCount: rippleCount,
      u_ripple0: [0, 0, 0, 0],
      u_ripple1: [0, 0, 0, 0],
      u_ripple2: [0, 0, 0, 0],
      u_ripple3: [0, 0, 0, 0],
      u_rippleAmps: [0, 0, 0, 0],
    };
    for (let i = 0; i < rippleCount; i += 1) {
      const r = activeRipples[i];
      const progress = Math.max(
        0,
        Math.min(1, (now - r.startTime) / (r.duration * 1000)),
      );
      rippleUniforms[`u_ripple${i}`] = [r.x, r.y, progress, r.radius];
      rippleUniforms.u_rippleAmps[i] = Number.isFinite(r.amplitude)
        ? r.amplitude
        : 1.2;
    }

    const targetWidth = Math.max(1, Math.round(targetCanvas.width || this.size));
    const targetHeight = Math.max(
      1,
      Math.round(targetCanvas.height || this.size),
    );
    if (
      this.canvas.width !== targetWidth ||
      this.canvas.height !== targetHeight
    ) {
      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;
    }

    const filterModes = { smooth: 0, crisp: 1 };
    const filterCode = filterModes[displayFilter] ?? 0;
    const z = Math.max(1, Math.min(8, Number(zoom) || 1));

    const visualizeUniforms = {
      u_palette: paletteCode,
      u_palettePhase: palettePhaseRad,
      u_showBarrier: showBarrier ? 1 : 0,
      u_channelView: channelViewCode,
      u_viewport: [targetWidth, targetHeight],
      u_zoom: z,
      u_pan: Array.isArray(pan) ? pan : [0, 0],
      u_displayFilter: filterCode,
      ...rippleUniforms,
    };

    if (decay > 0.001) {
      // History has its own bounded resolution. Viewport changes and exports
      // resize rectangular targets cleanly while preserving snapshot history.
      const historyScale = Math.min(
        1,
        768 / Math.max(targetWidth, targetHeight),
      );
      const historyWidth = Math.max(1, Math.round(targetWidth * historyScale));
      const historyHeight = Math.max(
        1,
        Math.round(targetHeight * historyScale),
      );
      if (!this.echoTargets) {
        this.echoTargets = [
          this.allocateEchoTarget(historyWidth, historyHeight),
          this.allocateEchoTarget(historyWidth, historyHeight),
        ];
        this.echoIndex = 0;
      } else if (
        !preserveEchoHistory &&
        (this.echoTargets[0].width !== historyWidth ||
          this.echoTargets[0].height !== historyHeight)
      ) {
        for (const target of this.echoTargets) this.releaseTarget(target);
        this.echoTargets = [
          this.allocateEchoTarget(historyWidth, historyHeight),
          this.allocateEchoTarget(historyWidth, historyHeight),
        ];
        this.echoIndex = 0;
      }
      if (
        this.currentFrameTarget?.width !== targetWidth ||
        this.currentFrameTarget?.height !== targetHeight
      ) {
        this.releaseTarget(this.currentFrameTarget);
        this.currentFrameTarget = this.allocate(targetWidth, targetHeight, true);
      }

      this.run(
        "visualize",
        this.currentFrameTarget,
        { u_state: this.state, u_barrier: this.barrier },
        visualizeUniforms,
      );

      const readTarget = this.echoTargets[this.echoIndex];
      const writeTarget = this.echoTargets[1 - this.echoIndex];
      this.run(
        "echo",
        null,
        { u_current: this.currentFrameTarget, u_history: readTarget },
        {
          u_viewport: [targetWidth, targetHeight],
          u_historyViewport: [readTarget.width, readTarget.height],
          u_historyAspect: readTarget.width / Math.max(1, readTarget.height),
          u_decay: decay,
          u_drift: drift,
          u_mode: echoModeCode,
          u_style: echoStyleCode,
          u_transform: TRANSFORM_CODES[this.coordinateTransform] ?? 0,
          u_zoom: z,
          u_pan: visualizeUniforms.u_pan,
          u_twist: clampGeometryTwist(this.coordinateTransform, this.twist),
          u_angle: this.rotation,
          u_geometryStrength: clampGeometryStrength(this.geometryStrength),
          u_geometryCenterX: this.geometryCenterX,
          u_geometryCenterY: this.geometryCenterY,
          u_geometrySoftness: this.geometrySoftness,
          u_foldCount: this.foldCount,
        },
      );
      if (!preserveEchoHistory) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, writeTarget.framebuffer);
        gl.blitFramebuffer(
          0,
          0,
          targetWidth,
          targetHeight,
          0,
          0,
          writeTarget.width,
          writeTarget.height,
          gl.COLOR_BUFFER_BIT,
          gl.LINEAR,
        );
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.echoIndex = 1 - this.echoIndex;
      }
    } else {
      this.run(
        "visualize",
        null,
        { u_state: this.state, u_barrier: this.barrier },
        visualizeUniforms,
      );
    }

    context.imageSmoothingEnabled = false;
    context.drawImage(this.canvas, 0, 0, targetWidth, targetHeight);
  }

  readState() {
    this.assertActive();
    const gl = this.gl;
    const packed = new Uint8Array(this.state.width * this.state.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.state.framebuffer);
    gl.readPixels(
      0,
      0,
      this.state.width,
      this.state.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      packed,
    );
    const data = new Uint8Array(this.size * this.size * CHANNELS);
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        for (let group = 0; group < 3; group += 1) {
          const source = (y * this.state.width + group * this.size + x) * 4;
          data.set(
            packed.subarray(source, source + 4),
            (y * this.size + x) * CHANNELS + group * 4,
          );
        }
      }
    }
    return data;
  }

  writeState(data) {
    this.assertActive();
    this.invalidateVitality();
    if (
      !(data instanceof Uint8Array) ||
      data.length !== this.size * this.size * CHANNELS
    ) {
      throw new Error("State must contain twelve encoded channels per cell.");
    }
    const packed = new Uint8Array(data.length);
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        for (let group = 0; group < 3; group += 1) {
          const source = (y * this.size + x) * CHANNELS + group * 4;
          packed.set(
            data.subarray(source, source + 4),
            (y * this.state.width + group * this.size + x) * 4,
          );
        }
      }
    }
    const gl = this.gl;
    for (const buffer of [this.state, this.nextState]) {
      gl.bindTexture(gl.TEXTURE_2D, buffer.texture);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        buffer.width,
        buffer.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        packed,
      );
    }
  }

  getLastUpdateMask() {
    this.assertActive();
    const mask = new Uint8Array(this.size * this.size);
    const [dx, dy] = this.lastOffset;
    for (let index = 0; index < this.layout.shuffle.length; index += 4) {
      const x =
        (this.layout.shuffle[index] +
          (this.layout.shuffle[index + 2] << 8) +
          dx) %
        this.size;
      const y =
        (this.layout.shuffle[index + 1] +
          (this.layout.shuffle[index + 3] << 8) +
          dy) %
        this.size;
      mask[y * this.size + x] = 1;
    }
    return mask;
  }

  handleContextLoss(event) {
    event?.preventDefault?.();
    this.lost = true;
    this.invalidateVitality();
    this._vitalityProbe?.dispose();
  }

  invalidateVitality() {
    this.generation = ++nextRuntimeGeneration;
    this._vitalityProbe?.invalidate(this.generation);
  }

  setProtectionMask(cells) {
    if (!(cells instanceof Uint8Array) || cells.length !== INTENT_SIZE ** 2)
      throw new Error("Protection requires a 32 by 32 intent mask.");
    this.assertActive();
    if (!this._protectionTexture)
      this._protectionTexture = this.allocate(INTENT_SIZE, INTENT_SIZE, false);
    if (!this._protectionBytes)
      this._protectionBytes = new Uint8Array(INTENT_SIZE ** 2 * 4);
    for (let index = 0; index < cells.length; index++)
      this._protectionBytes[index * 4] = cells[index];
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this._protectionTexture.texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      INTENT_SIZE,
      INTENT_SIZE,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this._protectionBytes,
    );
    this.invalidateVitality();
  }

  monitorVitality(timestamp, activeSeconds = 0) {
    if (
      this.disposed ||
      this.lost ||
      this._vitalityUnavailable ||
      (this.steps <= 0 && !this._vitalityProbe)
    )
      return null;
    if (this.gl.isContextLost()) {
      this.handleContextLoss();
      return null;
    }
    try {
      if (!this._vitalityProbe) {
        if (GpuVitalityProbe.supported(this.gl)) {
          for (const [name, source] of Object.entries({
            vitality: VITALITY_PROBE,
            vitalitySnapshot: VITALITY_SNAPSHOT,
          })) {
            const handle = link(this.gl, source);
            this.programs.push(handle);
            this.program[name] = { handle, locations: new Map() };
          }
          if (!this._protectionTexture)
            this.setProtectionMask(new Uint8Array(INTENT_SIZE ** 2));
        }
        this._vitalityProbe = new GpuVitalityProbe({
          gl: this.gl,
          size: this.size,
          allocate: (...args) => this.allocate(...args),
          render: (target, history, hasHistory) =>
            this.run(
              "vitality",
              target,
              {
                u_state: this.state,
                u_previous: history,
                u_barrier: this.barrier,
                u_intent: this._protectionTexture,
              },
              { u_hasHistory: hasHistory ? 1 : 0 },
            ),
          capture: (history) =>
            this.run("vitalitySnapshot", history, { u_state: this.state }),
        });
      }
      return this._vitalityProbe.update(timestamp, {
        generation: this.generation,
        steps: this.steps,
        activeSeconds,
      });
    } catch (error) {
      this._vitalityUnavailable = true;
      this._vitalityError = error;
      this._vitalityProbe?.dispose();
      return null;
    }
  }

  get vitalityProbe() {
    return this._vitalityProbe?.latest ?? null;
  }

  isDormant() {
    const probe = this.vitalityProbe;
    return Boolean(
      !this.disposed &&
      !this.lost &&
      !this.gl.isContextLost() &&
      probe?.generation === this.generation &&
      probe.coverage > 0.05 &&
      probe.rgbEnergy < 0.005 &&
      probe.hiddenEnergy < 0.005,
    );
  }

  getStats() {
    return {
      steps: this.steps,
      size: this.size,
      seed: this.seed,
      backend: "WebGL2 RGBA8",
      renderer: this.renderer,
      disposed: this.disposed,
      contextLost: this.lost,
      resources: {
        textures: this.textures.length,
        framebuffers: this.framebuffers.length,
        programs: this.programs.length,
        vaos: this.vao ? 1 : 0,
        bytes: this.textureBytes,
      },
    };
  }

  dispose() {
    if (this.disposed) return;
    this.invalidateVitality();
    this._vitalityProbe?.dispose();
    this.disposed = true;
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    if (this.gl) {
      for (const handle of this.textures) this.gl.deleteTexture(handle);
      for (const handle of this.framebuffers) this.gl.deleteFramebuffer(handle);
      for (const handle of this.programs) this.gl.deleteProgram(handle);
      if (this.vao) this.gl.deleteVertexArray(this.vao);
      this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.textures.length = 0;
    this.framebuffers.length = 0;
    this.programs.length = 0;
    this.vao = null;
    this.textureBytes = 0;
    this._motionFieldTexture = null;
    this._motionFieldMax = 0;
    this._protectionTexture = null;
    this._protectionBytes = null;
    this.canvas.width = 1;
    this.canvas.height = 1;
  }
}
