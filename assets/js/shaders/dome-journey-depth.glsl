uniform sampler2D u_depth;
uniform sampler2D u_journey_depth_echo;
uniform sampler2D u_journey_depth_dream;
uniform sampler2D u_journey_depth_structure;
uniform sampler2D u_journey_depth_cavern;
uniform vec4 u_journey_weights;
uniform float u_journey_source_weight;
uniform vec3 u_journey_depth_effects;
uniform float u_journey_distance;
uniform int u_journey_room_mode;
uniform vec4 u_journey_room_cells[4]; // cell x,z; valid; reserved

int journeyRoomSlot(ivec2 cell) {
  for (int i = 0; i < 4; i++)
    if (u_journey_room_cells[i].z > 0.5 && all(equal(cell, ivec2(u_journey_room_cells[i].xy)))) return i;
  return -1;
}
float journeyRoomDepth(vec2 mapped, int slot) {
  vec2 uv = vec2(mapped.x, 1.0 - mapped.y);
  if (slot == 0) return texture(u_journey_depth_echo, uv).r;
  if (slot == 1) return texture(u_journey_depth_dream, uv).r;
  if (slot == 2) return texture(u_journey_depth_structure, uv).r;
  if (slot == 3) return texture(u_journey_depth_cavern, uv).r;
  return texture(u_depth, uv).r;
}

float journeyDepth(vec2 mapped) {
  // CPU maps start at the top; photo textures are flipped during upload.
  vec2 uv = vec2(mapped.x, 1.0 - mapped.y);
  if (u_journey_enabled == 0 || u_journey_room_mode == 1) return texture(u_depth, uv).r;
  float depth = texture(u_depth, uv).r * u_journey_source_weight;
  if (u_journey_weights.x > 0.0) depth += texture(u_journey_depth_echo, uv).r * u_journey_weights.x;
  if (u_journey_weights.y > 0.0) depth += texture(u_journey_depth_dream, uv).r * u_journey_weights.y;
  if (u_journey_weights.z > 0.0) depth += texture(u_journey_depth_structure, uv).r * u_journey_weights.z;
  if (u_journey_weights.w > 0.0) depth += texture(u_journey_depth_cavern, uv).r * u_journey_weights.w;
  return clamp(depth, 0.0, 1.0);
}

vec2 journeyMappedUV(vec2 uv) {
  vec2 sphereUV = journeySphereUV(uv);
  vec2 mapped = domePhotoUV(sphereUV);
  if (u_journey_enabled == 0 || u_journey_depth_effects.x <= 0.0 || u_journey_distance <= 0.0) return mapped;
  float depth = journeyDepth(mapped);
  float lon = (sphereUV.x - 0.5) * 2.0 * PI;
  float lat = (sphereUV.y - 0.5) * PI;
  vec3 right = vec3(cos(lon), 0.0, sin(lon));
  vec3 up = vec3(-sin(lon) * sin(lat), cos(lat), cos(lon) * sin(lat));
  vec2 shift = vec2(dot(u_journey_offset, right), dot(u_journey_offset, up));
  shift *= depth * u_journey_depth_effects.x * 0.07 * smoothstep(0.0, 6.0, u_journey_distance);
  return domePhotoUV(sphereUV + shift);
}
