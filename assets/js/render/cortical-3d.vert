#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec2 a_uv;
uniform mat4 u_mvp;
uniform mat4 u_model;
uniform sampler2D u_depth;
uniform float u_extrude;
#include <cortical-waves>
out vec2 v_uv;
out vec3 v_worldPos;
out float v_waveVal;
out float v_baseDepth;
void main() {
  // Float depth rows are stored top-to-bottom; the mesh UV origin is bottom-left.
  float depth = texture(u_depth, vec2(a_uv.x, 1.0 - a_uv.y)).r;
  float wave = corticalWave(a_uv);
  float height = depth * u_extrude + wave * u_gain * 0.15;
  vec4 world = u_model * vec4(a_position.xy * u_aspect, height, 1.0);
  v_uv = a_uv;
  v_worldPos = world.xyz;
  v_waveVal = wave;
  v_baseDepth = depth;
  gl_Position = u_mvp * world;
}
