#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_source;
uniform vec3 u_viewPos;
uniform vec3 u_lightPos;
uniform float u_edge_coupling;
#include <cortical-waves>
in vec2 v_uv;
in vec3 v_worldPos;
in float v_waveVal;
in float v_baseDepth;
out vec4 out_color;
vec2 mirrorUV(vec2 uv) { return abs(mod(uv - 1.0, 2.0) - 1.0); }
vec3 photo(vec2 uv) { return texture(u_source, mirrorUV(uv)).rgb; }
float luminance(vec3 rgb) { return dot(rgb, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  vec3 areaNormal = cross(dFdx(v_worldPos), dFdy(v_worldPos));
  vec3 N = areaNormal / max(length(areaNormal), 1e-8);
  if (!gl_FrontFacing) N = -N;
  vec2 texel = 1.0 / vec2(textureSize(u_source, 0));
  float eps = 0.002;
  vec2 grad = vec2(
    corticalWave(v_uv + vec2(eps, 0.0)) - corticalWave(v_uv - vec2(eps, 0.0)),
    corticalWave(v_uv + vec2(0.0, eps)) - corticalWave(v_uv - vec2(0.0, eps))
  ) / (2.0 * eps);
  vec2 direction = grad / max(1.0, length(grad));
  vec2 edge = vec2(
    luminance(photo(v_uv + vec2(texel.x, 0.0))) - luminance(photo(v_uv - vec2(texel.x, 0.0))),
    luminance(photo(v_uv + vec2(0.0, texel.y))) - luminance(photo(v_uv - vec2(0.0, texel.y)))
  );
  vec2 refraction = u_gain * u_edge_coupling * (direction * 0.008 + edge * 0.03) * v_waveVal;
  vec2 dispersion = direction * u_gain * u_edge_coupling * 0.003;
  vec3 color = vec3(photo(v_uv + refraction + dispersion).r,
                    photo(v_uv + refraction).g,
                    photo(v_uv + refraction - dispersion).b);
  vec3 light = normalize(u_lightPos - v_worldPos);
  vec3 view = normalize(u_viewPos - v_worldPos);
  vec3 halfVector = normalize(light + view);
  float diffuse = max(dot(N, light), 0.0);
  float specular = pow(max(dot(N, halfVector), 0.0), 36.0);
  color = pow(max(color, vec3(0.0)), vec3(2.2));
  color *= 0.40 + 0.68 * diffuse + 0.03 * v_baseDepth;
  color += vec3(0.16, 0.19, 0.23) * specular;
  out_color = vec4(pow(max(color, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
}
