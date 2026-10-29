const float PI = 3.141592653589793;
uniform int u_mirrored_wrap;
vec2 domeSphereUV(vec3 direction) {
  vec3 dir = normalize(direction);
  return vec2(length(dir.xz) < 1e-7 ? 0.5 : atan(dir.x, -dir.z) / (2.0 * PI) + 0.5,
    asin(clamp(dir.y, -1.0, 1.0)) / PI + 0.5);
}
vec2 domePhotoUV(vec2 sphereUV) {
  if (u_mirrored_wrap == 0) return sphereUV;
  // Equivalent to atan(dir.z, dir.x), phased so reset view (-Z) looks
  // at the photo center. A quarter-turn in V keeps the horizon centered too.
  vec2 raw = vec2(sphereUV.x - 0.25, sphereUV.y - 0.25);
  vec2 mirrored = abs(mod(raw * 2.0 - 1.0, 2.0) - 1.0);
  // Longitude is undefined at the poles. Collapse to one sample there so
  // reflected depth and color cannot split the sphere at either cap.
  float cap = smoothstep(0.0, 0.08, min(sphereUV.y, 1.0 - sphereUV.y));
  mirrored.x = mix(0.5, mirrored.x, cap);
  return mirrored;
}
