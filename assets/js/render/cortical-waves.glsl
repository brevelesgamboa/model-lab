uniform float u_time;
uniform int u_wave_mode;
uniform float u_frequency;
uniform float u_speed;
uniform float u_gain;
uniform float u_eccentricity;
uniform vec2 u_fovea;
uniform vec2 u_aspect;

// A log-polar approximation to retinotopic mapping, with periodic angular
// harmonics. This is an analytic pattern generator, not a neural-field solver.
float corticalWave(vec2 uv) {
  vec2 z = (uv - u_fovea) * u_aspect;
  float r = length(z);
  float theta = atan(z.y, z.x + 1e-7);
  float u = log(1.0 + r / max(0.005, u_eccentricity));
  float t = u_time * u_speed;
  float envelope = smoothstep(0.0, 0.025, r);
  if (u_wave_mode == 0) return sin(u_frequency * u - t);
  if (u_wave_mode == 1) {
    float n = max(1.0, round(u_frequency * 0.5));
    return envelope * sin(n * theta - t);
  }
  if (u_wave_mode == 2) {
    float n = max(1.0, round(u_frequency * 0.4));
    return envelope * sin(u_frequency * 0.75 * u + n * theta - t);
  }
  // Quantize the angular component, then derive the radial component so the
  // three wave vectors remain 120 degrees apart AND meet at theta = ±pi.
  float n = max(1.0, round(u_frequency * 0.5));
  float k = 2.0 * n / sqrt(3.0);
  return envelope * (cos(k*u-t) + cos(-0.5*k*u+n*theta-t) + cos(-0.5*k*u-n*theta-t)) / 3.0;
}
