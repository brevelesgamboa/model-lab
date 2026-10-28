const float PI = 3.141592653589793;
vec2 domePhotoUV(vec2 sphereUV) {
  float longitude = (sphereUV.x - 0.5) * 2.0 * PI;
  float edge = radians(70.0);
  float angle = abs(longitude);
  // The front 140° spans the whole photo. Stretch a mirrored copy around the
  // rear, meeting at its center at ±180° (including matching seam slopes).
  float x = angle <= edge ? angle / (2.0 * edge)
    : 0.5 - (angle - edge) / (2.0 * (PI - edge));
  float u = 0.5 + sign(longitude) * x;
  // A shared radius at each pole closes the sphere even with a nonuniform map.
  float pole = smoothstep(0.0, 0.06, sphereUV.y)
    * smoothstep(0.0, 0.06, 1.0 - sphereUV.y);
  return vec2(mix(0.5, u, pole), sphereUV.y);
}
vec2 mirrorDomeUV(vec2 uv) { return abs(mod(uv - 1.0, 2.0) - 1.0); }
