#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_dream_360;
uniform vec3 u_viewDir;
uniform float u_gain;
uniform float u_time;
uniform float u_color_retention;
uniform float u_edge_coupling;
uniform float u_dispersion;
uniform float u_shininess;
uniform float u_fog_density;
#include <dome-mapping>
in vec2 v_uv;
in vec3 v_worldPos;
in vec3 v_normal;
in float v_waveVal;
out vec4 out_color;
vec3 sampleTextureSafe(vec2 uv) {
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
void main() {
  vec3 toEye = -normalize(v_worldPos);
  vec3 area = cross(dFdx(v_worldPos), dFdy(v_worldPos));
  vec3 faceNormal = length(area) > 1e-8 ? normalize(area) : normalize(v_normal);
  vec3 smoothNormal = normalize(v_normal);
  if (dot(faceNormal, toEye) < 0.0) faceNormal = -faceNormal;
  if (dot(smoothNormal, toEye) < 0.0) smoothNormal = -smoothNormal;
  vec3 N = normalize(mix(smoothNormal, faceNormal, 0.08));
  if (dot(N, toEye) < 0.0) N = -N;
  float facing = max(0.0, dot(N, toEye));
  vec2 uv = domeSphereUV(v_worldPos);
  float edgeCoupling = u_edge_coupling > 0.0 ? u_edge_coupling : 0.35;
  float dispersionAmt = u_dispersion > 0.0 ? u_dispersion : 0.0025;
  float shininessVal = u_shininess > 0.0 ? u_shininess : 32.0;
  float fogDensityVal = u_fog_density > 0.0 ? u_fog_density : 0.35;
  vec2 bend = N.xy * u_gain * (edgeCoupling * 0.017) * v_waveVal;
  vec2 dispersion = N.xy * u_gain * dispersionAmt * (1.0 - u_color_retention);
  vec3 color = vec3(photo(uv + bend + dispersion).r,
    photo(uv + bend).g, photo(uv + bend - dispersion).b);
  float distanceToEye = length(v_worldPos);
  float beam = smoothstep(0.25, 0.98, dot(normalize(v_worldPos), u_viewDir));
  float attenuation = 1.0 / (1.0 + 0.018 * distanceToEye * distanceToEye);
  float specular = pow(facing, max(1.0, shininessVal)) * beam * attenuation;
  color = pow(max(color, vec3(0.0)), vec3(2.2));
  color *= 0.40 + facing * attenuation * (0.55 + 0.25 * beam);
  color += mix(vec3(0.10, 0.12, 0.16), vec3(0.12), u_color_retention) * specular;
  float fresnel = pow(1.0 - facing, 3.0);
  vec3 rim = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + v_waveVal * 2.5 + u_time * 0.12);
  color += mix(rim, vec3(0.5), u_color_retention) * fresnel * u_gain * 0.6;
  float fog = 1.0 - exp(-fogDensityVal * max(0.0, distanceToEye - 6.0));
  color = pow(max(color, vec3(0.0)), vec3(1.0 / 2.2));
  out_color = vec4(mix(color, mix(vec3(8.0, 8.0, 12.0), vec3(8.0), u_color_retention) / 255.0, fog), 1.0);
}
