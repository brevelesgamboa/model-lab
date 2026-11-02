#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_dream_360;
uniform sampler2D u_neural;
uniform sampler2D u_journey_anchor;
uniform sampler2D u_journey_echo;
uniform sampler2D u_journey_dream;
uniform sampler2D u_journey_structure;
uniform sampler2D u_journey_cavern;
uniform float u_depth_extrude;
uniform float u_neural_extrude;
uniform float u_color_retention;
uniform float u_edge_coupling;
uniform float u_dispersion;
uniform vec3 u_viewPos;
#include <cortical-waves>
#include <dome-mapping>
#include <journey-mapping>
#include <journey-depth>
#include <journey-geometry>
#include <journey-feedback>
in vec2 v_uv;
in vec3 v_worldPos;
in vec3 v_normal;
in float v_waveVal;
out vec4 out_color;
float domeWave(vec2 uv) {
  float longitude = (uv.x - 0.5) * 2.0 * PI;
  float latitude = (uv.y - 0.5) * PI;
  return corticalWave(0.5 + 0.5 * vec2(sin(longitude) * cos(latitude), sin(latitude)));
}
float luminance(vec3 rgb) { return dot(rgb, vec3(0.2126, 0.7152, 0.0722)); }
vec3 sampleTextureSafe(vec2 uv) {
  if (u_journey_enabled == 1) {
    vec2 mapped = journeyMappedUV(uv);
    if (u_journey_room_mode == 1) return texture(u_journey_anchor, mapped).rgb;
    vec2 dx = dFdx(mapped), dy = dFdy(mapped);
    if (abs(dx.x) > 0.5) dx.x -= sign(dx.x);
    if (abs(dy.x) > 0.5) dy.x -= sign(dy.x);
    vec3 result = textureGrad(u_journey_anchor, mapped, dx, dy).rgb * u_journey_source_weight;
    if (u_journey_weights.x > 0.0) result += textureGrad(u_journey_echo, mapped, dx, dy).rgb * u_journey_weights.x;
    if (u_journey_weights.y > 0.0) result += textureGrad(u_journey_dream, mapped, dx, dy).rgb * u_journey_weights.y;
    if (u_journey_weights.z > 0.0) result += textureGrad(u_journey_structure, mapped, dx, dy).rgb * u_journey_weights.z;
    if (u_journey_weights.w > 0.0) result += textureGrad(u_journey_cavern, mapped, dx, dy).rgb * u_journey_weights.w;
    return result;
  }
  if (u_mirrored_wrap == 1) {
    vec2 mUV = domePhotoUV(uv);
    vec2 ddx = dFdx(mUV);
    vec2 ddy = dFdy(mUV);
    if (abs(ddx.x) > 0.5) ddx.x -= sign(ddx.x);
    if (abs(ddy.x) > 0.5) ddy.x -= sign(ddy.x);
    return textureGrad(u_dream_360, mUV, ddx, ddy).rgb;
  }
  // u_mirrored_wrap == 0: full equirectangular panorama
  // Handle 180-degree meridian seam wrap with safe derivative filtering and bilateral cross-fade
  vec2 ddx = dFdx(uv);
  vec2 ddy = dFdy(uv);
  if (abs(ddx.x) > 0.5) ddx.x -= sign(ddx.x);
  if (abs(ddy.x) > 0.5) ddy.x -= sign(ddy.x);
  float seamDist = min(uv.x, 1.0 - uv.x);
  float blendWidth = 30.0 / 360.0;
  if (seamDist < blendWidth) {
    float t = smoothstep(0.0, blendWidth, seamDist);
    vec2 altUV = vec2(uv.x < 0.5 ? uv.x + 1.0 : uv.x - 1.0, uv.y);
    vec3 cA = textureGrad(u_dream_360, uv, ddx, ddy).rgb;
    vec3 cB = textureGrad(u_dream_360, altUV, ddx, ddy).rgb;
    return mix(cB, cA, 0.5 + 0.5 * t);
  }
  return textureGrad(u_dream_360, uv, ddx, ddy).rgb;
}
vec3 photo(vec2 uv) { return sampleTextureSafe(uv); }

// Ground plane anchored to walking coordinates, with a fixed world horizon.
vec3 journeyGroundPlane(vec3 ray, vec3 sceneColor) {
  float eyeHeight = 1.35;
  float floorDist = -eyeHeight / min(ray.y, -0.01);
  vec2 worldFloor = ray.xz * floorDist + u_journey_position;
  vec2 tileCoord = worldFloor * 0.35;
  // Evaluate derivatives before the horizon branch for neighboring fragments.
  vec2 grid = abs(fract(tileCoord - 0.5) - 0.5) / max(fwidth(tileCoord), vec2(0.001));
  float seam = 1.0 - clamp(min(grid.x, grid.y) * 1.6, 0.0, 1.0);
  if (ray.y >= -0.01) return sceneColor;

  vec3 floorBase = vec3(0.025, 0.032, 0.045);
  vec3 jointGlow = u_journey_palette * 0.45 + vec3(0.06, 0.09, 0.14);
  vec3 floorColor = mix(floorBase, jointGlow, seam * 0.6);
  float fresnel = pow(clamp(1.0 + ray.y, 0.0, 1.0), 3.5);
  floorColor = mix(floorColor, sceneColor * 0.6 + jointGlow * 0.25, fresnel * 0.45);

  float horizonFade = 1.0 - smoothstep(-0.14, -0.01, ray.y);
  float distanceFade = 1.0 - smoothstep(10.0, 32.0, floorDist);
  // Unfold with the entrance, restoring the waking photo on the walk home.
  float presence = smoothstep(1.5, 4.0, u_journey_distance);
  float floorAlpha = horizonFade * distanceFade * presence * 0.88;
  return mix(sceneColor, floorColor, floorAlpha);
}

void main() {
  vec3 eyeVec = u_viewPos - v_worldPos;
  vec3 toEye = length(eyeVec) > 1e-6 ? normalize(eyeVec) : -normalize(v_worldPos);
  vec3 N = normalize(v_normal);
  if (dot(N, toEye) < 0.0) N = -N;
  float facing = max(0.0, dot(N, toEye));
  vec2 uv = domeSphereUV(v_worldPos);

  float edgeCoupling = u_edge_coupling;
  float dispersionAmt = clamp(u_dispersion, 0.0, 1.0);

  vec2 texel = 1.0 / vec2(textureSize(u_dream_360, 0));
  float eps = 0.002;
  vec2 grad = vec2(
    domeWave(uv + vec2(eps, 0.0)) - domeWave(uv - vec2(eps, 0.0)),
    domeWave(uv + vec2(0.0, eps)) - domeWave(uv - vec2(0.0, eps))
  ) / (2.0 * eps);
  vec2 direction = length(grad) > 1e-6 ? normalize(grad) : (length(N.xy) > 1e-6 ? normalize(N.xy) : vec2(0.0, 1.0));
  vec2 edge = vec2(
    luminance(photo(uv + vec2(texel.x, 0.0))) - luminance(photo(uv - vec2(texel.x, 0.0))),
    luminance(photo(uv + vec2(0.0, texel.y))) - luminance(photo(uv - vec2(0.0, texel.y)))
  );
  vec2 refraction = u_gain * edgeCoupling * (direction * 0.008 + edge * 0.03) * v_waveVal;
  vec2 dispersion = direction * u_gain * (dispersionAmt * (0.012 + edgeCoupling * 0.008));

  vec3 color = vec3(
    photo(uv + refraction + dispersion).r,
    photo(uv + refraction).g,
    photo(uv + refraction - dispersion).b
  );
  float fresnel = pow(1.0 - facing, 3.0);
  vec3 rim = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + v_waveVal * 2.5 + u_time * 0.12);
  color += rim * fresnel * u_gain * 0.25;
  if (u_journey_enabled == 1) {
    float depth = journeyDepth(journeyMappedUV(uv));
    float presence = smoothstep(0.0, 6.0, u_journey_distance);
    float mist = pow(1.0 - depth, 1.8) * u_journey_depth_effects.y * presence;
    color = mix(color, u_journey_palette * 0.35 + vec3(0.025, 0.035, 0.06), mist);
    float bands = depth * 22.0;
    float width = max(fwidth(bands), 0.04);
    float contour = 1.0 - smoothstep(width, width * 2.0, abs(fract(bands + 0.5) - 0.5));
    color += contour * u_journey_depth_effects.z * presence * (u_journey_palette * 0.5 + vec3(0.08, 0.16, 0.22));
  }
  bool opaqueWarp = u_journey_warp.x > 0.5 && u_journey_warp.y >= 0.12 && u_journey_warp.y <= 0.85;
  if (u_journey_enabled == 1 && u_journey_distance > 0.0 && !opaqueWarp) {
    // 0..1.5: separate the photo into real relative-depth surfaces. The traced
    // projection remains identical for the 1.5..4 aperture and full immersion.
    // Only the material unfolds within the source-anchored aperture; there is
    // no cross-fade to an unrelated tunnel projection at either boundary.
    vec3 ray = normalize(v_worldPos + vec3(refraction, 0.0));
    float separation = smoothstep(0.0, 1.5, u_journey_distance);
    color = mix(color, journeyGeometry(ray, color), separation);
  }
  if (u_journey_enabled == 1) color = journeyGroundPlane(normalize(v_worldPos), color);
  if (u_journey_enabled == 1) color = journeyFeedback(color, normalize(v_worldPos));
  if (u_journey_enabled == 1) color = journeyWarpChamber(normalize(v_worldPos), color);
  if (u_swap_rb > 0.5) color = color.bgr;
  out_color = vec4(color, 1.0);
}
