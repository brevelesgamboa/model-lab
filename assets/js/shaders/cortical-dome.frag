#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_source;
uniform vec3 u_viewDir;
uniform float u_gain;
uniform float u_time;
#include <dome-mapping>
in vec2 v_uv;
in vec3 v_worldPos;
in vec3 v_normal;
in float v_waveVal;
out vec4 out_color;
vec3 photo(vec2 uv) { return texture(u_source, mirrorDomeUV(uv)).rgb; }
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
  vec2 uv = domePhotoUV(v_uv);
  vec2 bend = N.xy * u_gain * v_waveVal * 0.006;
  vec2 dispersion = N.xy * u_gain * 0.0025;
  vec3 color = vec3(photo(uv + bend + dispersion).r,
    photo(uv + bend).g, photo(uv + bend - dispersion).b);
  float distanceToEye = length(v_worldPos);
  float beam = smoothstep(0.25, 0.98, dot(normalize(v_worldPos), u_viewDir));
  float attenuation = 1.0 / (1.0 + 0.018 * distanceToEye * distanceToEye);
  float specular = pow(facing, 32.0) * beam * attenuation;
  color = pow(max(color, vec3(0.0)), vec3(2.2));
  color *= 0.40 + facing * attenuation * (0.55 + 0.25 * beam);
  color += vec3(0.10, 0.12, 0.16) * specular;
  float fresnel = pow(1.0 - facing, 3.0);
  vec3 rim = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + v_waveVal * 2.5 + u_time * 0.12);
  color += rim * fresnel * u_gain * 0.6;
  float fog = 1.0 - exp(-0.35 * max(0.0, distanceToEye - 6.0));
  color = pow(max(color, vec3(0.0)), vec3(1.0 / 2.2));
  out_color = vec4(mix(color, vec3(8.0, 8.0, 12.0) / 255.0, fog), 1.0);
}
