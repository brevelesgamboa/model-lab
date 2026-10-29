#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec3 a_position;
layout(location=1) in vec2 a_uv;
uniform mat4 u_view;
uniform mat4 u_proj;
uniform sampler2D u_depth;
uniform sampler2D u_neural;
uniform float u_depth_extrude;
uniform float u_neural_extrude;
#include <cortical-waves>
#include <dome-mapping>
out vec2 v_uv;
out vec3 v_worldPos;
out vec3 v_normal;
out float v_waveVal;
float domeWave(vec2 uv) {
  float longitude = (uv.x - 0.5) * 2.0 * PI;
  float latitude = (uv.y - 0.5) * PI;
  // Periodic projection into the shared log-polar wave generator. Rear values
  // and slopes match; every longitude converges to the same value at a pole.
  return corticalWave(0.5 + 0.5 * vec2(sin(longitude)*cos(latitude), sin(latitude)));
}
float domeRadius(vec2 uv) {
  vec2 mapped = domePhotoUV(uv);
  vec2 scalarUV = vec2(mapped.x, 1.0 - mapped.y);
  return max(1.0, 5.0 - texture(u_depth, scalarUV).r * u_depth_extrude
    - texture(u_neural, scalarUV).r * u_neural_extrude
    - domeWave(uv) * u_gain * 0.4);
}
vec3 domePoint(vec2 uv) {
  float longitude = (uv.x - 0.5) * 2.0 * PI;
  float latitude = (uv.y - 0.5) * PI;
  vec3 direction = vec3(sin(longitude) * cos(latitude), sin(latitude),
    -cos(longitude) * cos(latitude));
  return direction * domeRadius(uv);
}
void main() {
  vec2 mapUV = domePhotoUV(domeSphereUV(a_position));
  // CPU float maps have their first row at the top; photo textures are flipped
  // on upload so all three inputs align with the bottom-up spherical UVs.
  vec2 scalarUV = vec2(mapUV.x, 1.0 - mapUV.y);
  float d = texture(u_depth, scalarUV).r;
  float n = texture(u_neural, scalarUV).r;
  float waveVal = domeWave(a_uv);
  float radius = max(1.0, 5.0 - d * u_depth_extrude
    - n * u_neural_extrude - waveVal * u_gain * 0.4);
  vec3 worldPos = a_position * radius;
  v_uv = a_uv;
  v_worldPos = worldPos;
  // Smooth normals from the same cached fields, interpolated across the mesh.
  // This avoids lighting every triangle as a separate hard-edged tile.
  vec2 du = vec2(0.002, 0.0), dv = vec2(0.0, 0.002);
  vec3 tangentU = domePoint(a_uv + du) - domePoint(a_uv - du);
  vec3 tangentV = domePoint(a_uv + dv) - domePoint(a_uv - dv);
  vec3 normal = cross(tangentU, tangentV);
  v_normal = length(normal) > 1e-7 ? normalize(normal) : -a_position;
  v_waveVal = waveVal;
  gl_Position = u_proj * u_view * vec4(worldPos, 1.0);
}
