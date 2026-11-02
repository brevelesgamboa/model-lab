uniform sampler2D u_journey_history;
uniform vec2 u_journey_resolution;
uniform vec2 u_journey_motion;
uniform float u_journey_history_valid;

vec3 journeyFeedback(vec3 fresh, vec3 worldRay) {
  if (u_journey_history_valid < 0.5 || u_journey_style.y <= 0.0) return fresh;
  vec2 uv = gl_FragCoord.xy / u_journey_resolution;
  // Exactly 16 framebuffer pixels per block at every render resolution.
  ivec2 block = ivec2(floor(gl_FragCoord.xy / 16.0));
  float h = float(dreamHash(block) % 1024u) / 1024.0;
  // Quantized motion carries pieces of the preceding view into this one.
  vec2 motionPixels = u_journey_motion * u_journey_resolution;
  float moving = smoothstep(0.1, 2.0, length(motionPixels));
  vec2 slip = vec2(h - 0.5, float(dreamHash(block + ivec2(17, 31)) % 1024u) / 1024.0 - 0.5);
  vec2 dragPixels = round(motionPixels * (0.6 + h * 1.7) + slip * 16.0 * moving * u_journey_style.y);
  vec2 drag = dragPixels / u_journey_resolution;
  vec2 historyUV = uv - drag;
  if (any(lessThan(historyUV, vec2(0.0))) || any(greaterThan(historyUV, vec2(1.0)))) return fresh;
  vec3 previous = texture(u_journey_history, historyUV).rgb;
  float mask = smoothstep(0.22, 0.55, h);
  // Every frame injects fresh photo detail; feedback can never become a closed loop.
  float retain = min(0.82, pow(u_journey_style.y, 0.65) * (0.98 - u_journey_style.w * 0.16));
  retain *= sqrt(max(0.0, 1.0 - u_journey_style.w));
  vec2 focal = (uv - 0.5) * vec2(1.0, 0.8);
  float opening = exp(-dot(focal, focal) * 20.0);
  retain *= 1.0 - opening * u_journey_style.w * 0.75;
  return mix(fresh, previous, mask * retain * u_journey_geometry * journeyAperture(worldRay));
}
