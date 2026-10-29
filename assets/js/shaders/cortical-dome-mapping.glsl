const float PI = 3.141592653589793;
vec2 domeSphereUV(vec3 direction) {
  vec3 dir = normalize(direction);
  // Standard longitude/latitude, rotated to center the photo at reset view (-Z).
  return vec2(atan(dir.x, -dir.z) / (2.0 * PI) + 0.5,
    asin(clamp(dir.y, -1.0, 1.0)) / PI + 0.5);
}
vec2 domePhotoUV(vec2 sphereUV) { return sphereUV; }
