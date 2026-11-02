uniform int u_journey_enabled;
uniform vec3 u_journey_offset;
vec2 journeySphereUV(vec2 uv) {
  if (u_journey_enabled == 0 || length(u_journey_offset) < 1e-7) return uv;
  float lon = (uv.x - 0.5) * 2.0 * PI;
  float lat = (uv.y - 0.5) * PI;
  vec3 ray = vec3(sin(lon) * cos(lat), sin(lat), -cos(lon) * cos(lat));
  float projection = dot(ray, u_journey_offset);
  float distance = -projection + sqrt(max(0.0, projection * projection + 1.0 - dot(u_journey_offset, u_journey_offset)));
  return domeSphereUV(u_journey_offset + distance * ray);
}
