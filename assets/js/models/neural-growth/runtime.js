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
import { hexToRgb } from "../../core/utils.js";
import { ResonanceConfig } from "./resonance-config.js";

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
  if (u_transform != 0 && u_geometryStrength > 0.0001) {
    vec2 centerOffset = vec2(u_geometryCenterX, u_geometryCenterY);
    vec2 pos = ((vec2(xy) + 0.5) / (float(u_size) * 0.5) - 1.0) - centerOffset;
    float r = length(pos);
    float r_eff = sqrt(r * r + 0.0001 + u_geometrySoftness * 0.15);
    float phi = atan(pos.y, pos.x);
    float transTheta = effectiveAngle;
    if (u_transform == 1) {
      transTheta = phi + 1.5707963 + u_twist + effectiveAngle;
    } else if (u_transform == 2) {
      transTheta = phi + 1.5707963 + log(max(r_eff, 0.01)) * tan(u_twist) + effectiveAngle;
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
    float activeStrength = clamp(u_geometryStrength * edgeFalloff, 0.0, 1.0);
    vec2 vBase = vec2(cos(effectiveAngle), sin(effectiveAngle));
    vec2 vTrans = vec2(cos(transTheta), sin(transTheta));
    vec2 vBlend = mix(vBase, vTrans, activeStrength);
    if (length(vBlend) > 0.0001) {
      theta = atan(vBlend.y, vBlend.x);
    } else {
      theta = transTheta;
    }
  }
  vec4 orient = texelFetch(u_orientation, xy, 0);
  if (orient.b > 0.05) {
    vec2 dir = orient.rg * 2.0 - 1.0;
    float groomedAngle = atan(dir.y, dir.x);
    theta = mix(theta, groomedAngle, orient.b);
  }
  float cosA = cos(theta);
  float sinA = sin(theta);
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
uniform sampler2D u_dreamGrad;
uniform ivec2 u_offset;
uniform float u_latentFeedback;
uniform float u_latentDecay;
uniform float u_noiseStrength;
uniform float u_dreamStrength;
uniform float u_dreamChroma;
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
  if (group == 0 && u_dreamStrength > 0.0001) {
    vec2 dreamUv = (vec2(xy) + 0.5) / float(u_size);
    vec3 dreamDelta = (textureLod(u_dreamGrad, dreamUv, 0.0).rgb - 127.0 / 255.0) * 2.0;
    float dreamLum = dot(dreamDelta, vec3(0.299, 0.587, 0.114));
    vec3 effectiveDream = mix(vec3(dreamLum), dreamDelta, clamp(u_dreamChroma, 0.0, 1.0));
    delta.rgb += effectiveDream * u_dreamStrength;
  }
  if (group > 0 && u_noiseStrength > 0.0001) {
    delta += hashNoise(xy, group, u_stepSeed) * u_noiseStrength;
  }
  vec4 prevDecoded = decodeState(previous);
  vec4 targetState = prevDecoded + delta;
  if (group > 0 && u_latentMomentum > 0.0001) {
    targetState = mix(targetState, prevDecoded + delta * (1.0 - u_latentMomentum * 0.75), u_latentMomentum);
  }
  if (group > 0 && u_latentFeedback > 0.0001) {
    targetState = mix(targetState, prevDecoded * u_latentDecay, u_latentFeedback);
  }
  out_color = encodeState(clamp(targetState, -2.0, 2.0));
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
uniform ivec2 u_center;
uniform float u_radius;
uniform float u_ringRadius;
uniform float u_ringWidth;
uniform float u_strength;
uniform int u_mode;
uniform vec3 u_dyeColor;
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
  if (u_mode == 5 || u_mode == 6 || u_mode == 7 || u_mode == 8) {
    float angle = atan(delta.y, delta.x);
    float rMod = u_radius * (1.0 + 0.22 * cos(3.0 * angle + 1.25) + 0.12 * sin(5.0 * angle));
    if (dist <= rMod) {
      float sigma = max(2.0, rMod * 0.45);
      weight = exp(-(dist * dist) / (2.0 * sigma * sigma)) * u_strength;
    }
  } else if (u_ringRadius > 0.0) {
    float diff = dist - u_ringRadius;
    if (abs(diff) <= 3.5 * u_ringWidth) {
      weight = exp(-(diff * diff) / (2.0 * u_ringWidth * u_ringWidth)) * u_strength;
    }
  } else if (dist <= u_radius) {
    weight = smoothstep(u_radius, u_radius * 0.35, dist);
  }
  if (weight < 0.001) {
    out_color = texelFetch(u_state, p, 0);
    return;
  }
  if (u_lockBarrier == 1 && texelFetch(u_barrier, xy, 0).r > 0.5) {
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
    out_color = mix(current, vec4(n1, n2, n3, n4), weight);
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
  } else if (u_mode == 3) {
    out_color = current;
  } else {
    out_color = mix(current, vec4(127.0 / 255.0), weight);
  }
}`;

const VISUALIZE = `${PREFIX}
uniform sampler2D u_state;
uniform sampler2D u_barrier;
uniform int u_palette;
uniform float u_palettePhase;
uniform int u_showBarrier;
uniform int u_rippleCount;
uniform int u_rippleStyle;
uniform vec3 u_rippleTint;
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

vec2 computeRippleDisplacement(vec2 pos, vec4 rippleData, float amplitude, int style) {
  if (rippleData.z <= 0.0 || rippleData.z >= 1.0) return vec2(0.0);
  vec2 origin = rippleData.xy;
  float progress = rippleData.z;
  float maxRadius = rippleData.w;
  vec2 delta = pos - origin;
  float dist = length(delta);
  float currentRadius = progress * maxRadius;
  float diff = dist - currentRadius;
  float waveWidth = max(8.0, maxRadius * 0.12);
  float spatialEnv = exp(-(diff * diff) / (2.0 * waveWidth * waveWidth));
  float timeFade = 1.0 - progress;
  timeFade = timeFade * timeFade;
  float wave = sin(diff * (3.14159265 / waveWidth));
  if (style == 3) {
    wave = wave + 0.45 * sin(diff * (6.28318530 / waveWidth));
  }
  wave = wave * spatialEnv * timeFade * amplitude;
  vec2 dir = dist > 0.5 ? delta / dist : vec2(0.0);
  return dir * wave;
}

float computeRippleGlow(vec2 pos, vec4 rippleData, float amplitude) {
  if (rippleData.z <= 0.0 || rippleData.z >= 1.0) return 0.0;
  vec2 origin = rippleData.xy;
  float progress = rippleData.z;
  float maxRadius = rippleData.w;
  float dist = length(pos - origin);
  float currentRadius = progress * maxRadius;
  float diff = dist - currentRadius;
  float waveWidth = max(8.0, maxRadius * 0.12);
  float spatialEnv = exp(-(diff * diff) / (2.0 * waveWidth * waveWidth));
  float timeFade = 1.0 - progress;
  return spatialEnv * timeFade * timeFade * amplitude;
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
  vec2 vpSize = u_viewport.x > 0 ? vec2(u_viewport) : vec2(float(u_size));
  vec2 uv = gl_FragCoord.xy / vpSize;
  float z = u_zoom > 0.0 ? u_zoom : 1.0;
  float srcExtent = float(u_size) / z;
  float srcOffset = (float(u_size) - srcExtent) * 0.5;
  vec2 pos = srcOffset + u_pan * float(u_size) + uv * srcExtent;

  vec2 disp = vec2(0.0);
  float totalGlow = 0.0;
  if (u_rippleCount > 0) {
    disp += computeRippleDisplacement(pos, u_ripple0, u_rippleAmps.x, u_rippleStyle);
    if (u_rippleStyle == 2) totalGlow += computeRippleGlow(pos, u_ripple0, u_rippleAmps.x);
  }
  if (u_rippleCount > 1) {
    disp += computeRippleDisplacement(pos, u_ripple1, u_rippleAmps.y, u_rippleStyle);
    if (u_rippleStyle == 2) totalGlow += computeRippleGlow(pos, u_ripple1, u_rippleAmps.y);
  }
  if (u_rippleCount > 2) {
    disp += computeRippleDisplacement(pos, u_ripple2, u_rippleAmps.z, u_rippleStyle);
    if (u_rippleStyle == 2) totalGlow += computeRippleGlow(pos, u_ripple2, u_rippleAmps.z);
  }
  if (u_rippleCount > 3) {
    disp += computeRippleDisplacement(pos, u_ripple3, u_rippleAmps.w, u_rippleStyle);
    if (u_rippleStyle == 2) totalGlow += computeRippleGlow(pos, u_ripple3, u_rippleAmps.w);
  }
  float dispLen = length(disp);
  if (dispLen > 1.8) {
    disp = (disp / dispLen) * 1.8;
  }
  vec3 rawRgb;
  vec2 pBase = pos - disp;
  if (u_channelView == 0 && dispLen > 0.001 && u_rippleStyle == 1) {
    float r = sampleGroup(pos - disp * 1.35, 0).r * 0.5 + 0.5;
    float g = sampleGroup(pos - disp * 1.00, 0).g * 0.5 + 0.5;
    float b = sampleGroup(pos - disp * 0.65, 0).b * 0.5 + 0.5;
    rawRgb = vec3(r, g, b);
  } else {
    rawRgb = sampleRawColor(pBase);
  }

  // Soft highlight compression: smoothly rolls off intense highlights above 0.5
  vec3 rgb = rawRgb / (1.0 + max(vec3(0.0), rawRgb - 0.5) * 0.85);
  rgb = clamp(rgb, 0.0, 1.0);

  if (u_rippleStyle == 2 && totalGlow > 0.001) {
    rgb = clamp(rgb + u_rippleTint * totalGlow * 0.75, 0.0, 1.0);
  }

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
    ivec2 bCoord = ivec2(floor(clamp(pos, vec2(0.0), vec2(float(u_size - 1)))));
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

void main() {
  vec2 pos = (v_uv - 0.5 - vec2(u_geometryCenterX, u_geometryCenterY)) * 2.0;
  float r = length(pos);
  float phi = atan(pos.y, pos.x);

  vec2 driftDir = vec2(cos(u_angle), sin(u_angle));
  if (u_mode == 0) {
    float theta = u_angle;
    if (u_transform == 1) {
      theta = phi + 1.5707963 + u_twist + u_angle;
    } else if (u_transform == 2) {
      float r_eff = sqrt(r * r + 0.0001 + u_geometrySoftness * 0.15);
      theta = phi + 1.5707963 + log(max(r_eff, 0.01)) * tan(u_twist) + u_angle;
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

  float stepLen = u_drift * 0.006;
  vec2 uv_r = fract(v_uv - driftDir * (stepLen * 1.05));
  vec2 uv_g = fract(v_uv - driftDir * stepLen);
  vec2 uv_b = fract(v_uv - driftDir * (stepLen * 0.95));

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
    this.onContextLost = (event) => {
      event.preventDefault();
      this.lost = true;
    };
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
      const neutralGradient = new Uint8Array(192 * 192 * 4).fill(127);
      this.dreamGradTexture = this.allocate(192, 192, false, neutralGradient);
      gl.bindTexture(gl.TEXTURE_2D, this.dreamGradTexture.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      this.dreamStrength = 0.0;
      this.dreamChroma = 0.0;
      this._phenotypeTarget = null;
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
      if (!program.locations.has(key))
        program.locations.set(key, gl.getUniformLocation(program.handle, key));
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
          "u_rippleCount",
          "u_rippleStyle",
          "u_channelView",
          "u_displayFilter",
          "u_stepSeed",
        ].includes(key)
      )
        gl.uniform1i(location(key), value);
      else gl.uniform1f(location(key), value);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  restart(seed = this.seed) {
    this.assertActive();
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
    if (this.dreamGradTexture) {
      const gw = this.dreamGradTexture.width;
      const gh = this.dreamGradTexture.height;
      const neutralGradient = new Uint8Array(gw * gh * 4).fill(127);
      gl.bindTexture(gl.TEXTURE_2D, this.dreamGradTexture.texture);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        gw,
        gh,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        neutralGradient,
      );
    }
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
      dreamStrength = this.dreamStrength,
      dreamChroma = this.dreamChroma,
      foldCount = this.foldCount,
      latentMomentum = this.latentMomentum,
    } = {},
  ) {
    this.assertActive();
    this.rotation = Number(rotation) || 0;
    this.topology = topology === "hexagonal" ? "hexagonal" : "square";
    this.coordinateTransform = coordinateTransform || "cartesian";
    this.twist = Number(twist) || 0;
    this.foldCount = Number.isFinite(Number(foldCount))
      ? Math.max(3.0, Math.min(12.0, Number(foldCount)))
      : 6.0;
    this.latentMomentum = Number.isFinite(Number(latentMomentum))
      ? Math.max(0.0, Math.min(0.9, Number(latentMomentum)))
      : 0.0;
    this.dreamStrength = Number.isFinite(Number(dreamStrength))
      ? Math.max(0.0, Math.min(1.0, Number(dreamStrength)))
      : 0.0;
    this.dreamChroma = Number.isFinite(Number(dreamChroma))
      ? Math.max(0.0, Math.min(1.0, Number(dreamChroma)))
      : 0.0;
    this.geometryStrength = Number.isFinite(Number(geometryStrength))
      ? Math.max(0.0, Math.min(1.0, Number(geometryStrength)))
      : 1.0;
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
    const transformCode =
      this.coordinateTransform === "vortex"
        ? 1
        : this.coordinateTransform === "spiral"
          ? 2
          : this.coordinateTransform === "julia"
            ? 3
            : this.coordinateTransform === "dipole"
              ? 4
              : this.coordinateTransform === "wave"
                ? 5
                : this.coordinateTransform === "saddle"
                  ? 6
                  : this.coordinateTransform === "kaleidoscope"
                    ? 7
                    : this.coordinateTransform === "vortex_pair"
                      ? 8
                      : this.coordinateTransform === "voronoi"
                        ? 9
                        : 0;
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
          u_dreamGrad: this.dreamGradTexture,
        },
        {
          u_offset: this.lastOffset,
          u_latentFeedback: resUniforms?.latentFeedback ?? 0.0,
          u_latentDecay: resUniforms?.latentDecay ?? 1.0,
          u_noiseStrength: resUniforms?.noiseStrength ?? 0.0,
          u_dreamStrength: this.dreamStrength,
          u_dreamChroma: this.dreamChroma,
          u_latentMomentum: this.latentMomentum,
          u_stepSeed: resUniforms?.stepSeed ?? 0,
        },
      );
      [this.state, this.nextState] = [this.nextState, this.state];
      this.steps += 1;
    }
  }

  disturb(
    x,
    y,
    radius = 8,
    mode = "erase",
    {
      dyeColor = [0, 0.94, 1],
      strokeAngle = 0,
      lockBarrier = true,
      shockwaveImpact = "color",
      ringRadius = 0,
      ringWidth = 8,
      strength = 1.0,
    } = {},
  ) {
    this.assertActive();
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
    let effectiveRingRadius = Number(ringRadius) || 0;
    let effectiveRingWidth =
      Number(ringWidth) || Math.max(6, Math.min(24, radius * 0.12));
    let effectiveStrength = Number(strength) ?? 1.0;
    let effectiveRadius = radius;
    if (mode === "noise") modeCode = 1;
    else if (mode === "dye") modeCode = 2;
    else if (mode === "invert") modeCode = 4;
    else if (mode === "shockwave") {
      const impact = shockwaveImpact || "color";
      if (impact === "color") {
        modeCode = 5;
        effectiveRadius = Math.min(
          12,
          Math.max(6, Math.round(this.size * 0.05)),
        );
        effectiveStrength = 0.18;
      } else {
        modeCode = 3;
      }
    } else if (mode === "kick_color") modeCode = 5;
    else if (mode === "kick_perturb") modeCode = 6;
    else if (mode === "kick_hidden_perturb" || mode === "infuse") modeCode = 7;
    else if (mode === "kick_hidden_prune" || mode === "prune") modeCode = 8;
    this.run(
      "disturb",
      this.nextState,
      { u_state: this.state, u_barrier: this.barrier },
      {
        u_center: [x, y],
        u_radius: effectiveRadius,
        u_ringRadius: effectiveRingRadius,
        u_ringWidth: effectiveRingWidth,
        u_strength: effectiveStrength,
        u_mode: modeCode,
        u_dyeColor: Array.isArray(dyeColor) ? dyeColor : [0, 0.94, 1],
        u_lockBarrier: lockBarrier ? 1 : 0,
      },
    );
    [this.state, this.nextState] = [this.nextState, this.state];
  }

  clearBarrier() {
    this.assertActive();
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
      shockwaveStyle = "refract",
      dyeColor = "#00f0ff",
      channelView = "phenotype",
      echoDecay = 0.0,
      echoDrift = 0.25,
      echoMode = "field_advection",
      echoStyle = "phosphor",
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

    const rippleStyles = { refract: 0, chromatic: 1, glow: 2, harmonic: 3 };
    const rippleStyleCode = rippleStyles[shockwaveStyle] ?? 0;
    const dyeRgb =
      typeof dyeColor === "string"
        ? hexToRgb(dyeColor)
        : Array.isArray(dyeColor)
          ? dyeColor
          : [0, 240, 255];
    const rippleTint = [
      (dyeRgb[0] || 0) / 255,
      (dyeRgb[1] || 0) / 255,
      (dyeRgb[2] || 0) / 255,
    ];

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
      rippleUniforms.u_rippleAmps[i] = r.amplitude || 1.2;
    }

    const extent = Math.max(
      1,
      Math.min(
        targetCanvas.width || this.size,
        targetCanvas.height || this.size,
      ),
    );
    if (this.canvas.width !== extent || this.canvas.height !== extent) {
      this.canvas.width = extent;
      this.canvas.height = extent;
    }

    const filterModes = { smooth: 0, crisp: 1, ultra: 0, cas: 0, hybrid: 0 };
    const filterCode = filterModes[displayFilter] ?? 0;
    const z = Math.max(1, Math.min(8, Number(zoom) || 1));

    const visualizeUniforms = {
      u_palette: paletteCode,
      u_palettePhase: palettePhaseRad,
      u_showBarrier: showBarrier ? 1 : 0,
      u_rippleStyle: rippleStyleCode,
      u_rippleTint: rippleTint,
      u_channelView: channelViewCode,
      u_viewport: [extent, extent],
      u_zoom: z,
      u_pan: Array.isArray(pan) ? pan : [0, 0],
      u_displayFilter: filterCode,
      ...rippleUniforms,
    };

    if (decay > 0.001) {
      if (
        !this.echoTargets ||
        this.echoTargets[0].width !== extent ||
        this.echoTargets[0].height !== extent
      ) {
        // Playback, paused inspection and exports can use different display sizes.
        for (const target of this.echoTargets || []) this.releaseTarget(target);
        this.releaseTarget(this.currentFrameTarget);
        this.echoTargets = [
          this.allocateEchoTarget(extent, extent),
          this.allocateEchoTarget(extent, extent),
        ];
        this.currentFrameTarget = this.allocate(extent, extent, true);
        this.echoIndex = 0;
      }

      this.run(
        "visualize",
        this.currentFrameTarget,
        { u_state: this.state, u_barrier: this.barrier },
        visualizeUniforms,
      );

      const readTarget = this.echoTargets[this.echoIndex];
      const writeTarget = this.echoTargets[1 - this.echoIndex];
      const transformCode =
        this.coordinateTransform === "ring"
          ? 1
          : this.coordinateTransform === "spiral"
            ? 2
            : this.coordinateTransform === "wave"
              ? 5
              : this.coordinateTransform === "saddle"
                ? 6
                : this.coordinateTransform === "kaleidoscope"
                  ? 7
                  : this.coordinateTransform === "vortex_pair"
                    ? 8
                    : this.coordinateTransform === "voronoi"
                      ? 9
                      : 0;
      this.run(
        "echo",
        writeTarget,
        { u_current: this.currentFrameTarget, u_history: readTarget },
        {
          u_decay: decay,
          u_drift: drift,
          u_mode: echoModeCode,
          u_style: echoStyleCode,
          u_transform: transformCode,
          u_twist: this.twist,
          u_angle: this.rotation,
          u_geometryStrength: this.geometryStrength,
          u_geometryCenterX: this.geometryCenterX,
          u_geometryCenterY: this.geometryCenterY,
          u_geometrySoftness: this.geometrySoftness,
          u_foldCount: this.foldCount,
        },
      );
      this.echoIndex = 1 - this.echoIndex;

      const gl = this.gl;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, writeTarget.framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(
        0,
        0,
        extent,
        extent,
        0,
        0,
        extent,
        extent,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      this.run(
        "visualize",
        null,
        { u_state: this.state, u_barrier: this.barrier },
        visualizeUniforms,
      );
    }

    context.imageSmoothingEnabled = false;
    const drawX = Math.round((targetCanvas.width - extent) * 0.5);
    const drawY = Math.round((targetCanvas.height - extent) * 0.5);
    if (
      drawX > 0 ||
      drawY > 0 ||
      targetCanvas.width !== extent ||
      targetCanvas.height !== extent
    ) {
      context.fillStyle = "#101218";
      context.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
    }
    context.drawImage(this.canvas, drawX, drawY, extent, extent);
  }

  updateDreamGradient(uint8Array, width = 192, height = 192) {
    this.assertActive();
    if (!uint8Array || uint8Array.length !== width * height * 4) return;
    const gl = this.gl;
    if (
      !this.dreamGradTexture ||
      this.dreamGradTexture.width !== width ||
      this.dreamGradTexture.height !== height
    ) {
      this.dreamGradTexture = this.allocate(width, height, false, uint8Array);
      gl.bindTexture(gl.TEXTURE_2D, this.dreamGradTexture.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.dreamGradTexture.texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      width,
      height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      uint8Array,
    );
  }

  readPhenotypeRgb(targetWidth = 192, targetHeight = 192) {
    this.assertActive();
    const gl = this.gl;
    if (
      !this._phenotypeTarget ||
      this._phenotypeTarget.width !== targetWidth ||
      this._phenotypeTarget.height !== targetHeight
    ) {
      this._phenotypeTarget = this.allocate(targetWidth, targetHeight, true);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.state.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._phenotypeTarget.framebuffer);
    gl.blitFramebuffer(
      0,
      0,
      this.size,
      this.size,
      0,
      0,
      targetWidth,
      targetHeight,
      gl.COLOR_BUFFER_BIT,
      gl.LINEAR,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._phenotypeTarget.framebuffer);
    const rawBytes = new Uint8Array(targetWidth * targetHeight * 4);
    gl.readPixels(
      0,
      0,
      targetWidth,
      targetHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      rawBytes,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return rawBytes;
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

  isDormant() {
    if (this.disposed || this.lost) return false;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.state.framebuffer);
    const pixels = new Uint8Array(8 * 8 * 4);
    const offset = Math.max(0, Math.floor(this.size / 2) - 4);
    gl.readPixels(offset, offset, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let totalDiff = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      totalDiff +=
        Math.abs(pixels[i] - 127) +
        Math.abs(pixels[i + 1] - 127) +
        Math.abs(pixels[i + 2] - 127);
    }
    return totalDiff < 64;
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
    this._phenotypeTarget = null;
    this.dreamGradTexture = null;
    this.canvas.width = 1;
    this.canvas.height = 1;
  }
}
