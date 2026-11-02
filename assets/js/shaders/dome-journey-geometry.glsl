uniform float u_swap_rb;
vec3 journeyPhotoColor(vec3 color) { return u_swap_rb > 0.5 ? color.bgr : color; }
uniform vec3 u_viewDir;
uniform vec4 u_journey_warp; // active, normalized progress, elapsed seconds, surge
uniform float u_journey_geometry;
uniform vec2 u_journey_position;
uniform vec3 u_journey_camera_offset;
uniform vec3 u_journey_palette;
uniform float u_journey_faithfulness;
uniform float u_journey_retro;
uniform uint u_journey_seed;
uniform vec4 u_journey_style; // local recursion/corruption/density, global clarity

uint dreamHash(ivec2 cell) {
  uint h = uint(cell.x) * 73856093u ^ uint(cell.y) * 19349663u ^ u_journey_seed;
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  return h ^ (h >> 16u);
}
bool dreamBridge(ivec2 cell) {
  return all(equal(cell, ivec2(0))) || dreamHash(cell) % 7u > 2u;
}
vec2 dreamWarp(vec2 p) {
  float phase = float(u_journey_seed % 1024u) * 0.013;
  return p + 1.8 * vec2(sin(p.y * 0.14 + phase) - sin(phase), sin(p.x * 0.13 - phase) + sin(phase));
}
vec2 dreamMirror(vec2 uv) { return 1.0 - abs(mod(uv, 2.0) - 1.0); }

// One world-anchored aperture around the original photo direction (-Z). It does
// not follow mouse look. Its endpoints have zero slope and reverse spatially.
float journeyAperture(vec3 direction) {
  float progress = smoothstep(1.5, 4.0, u_journey_distance);
  float angle = acos(clamp(normalize(direction).z * -1.0, -1.0, 1.0));
  float theta = atan(direction.y, direction.x + 1e-8);
  float logRadius = log(1.0 + angle / max(0.015, u_eccentricity));
  float tear = sin(6.0 * theta + 4.0 * logRadius) * 0.06 * progress * (1.0 - progress);
  float radius = progress * (PI + 0.3) + tear;
  float edge = smoothstep(0.0, 0.16, progress);
  return edge * (1.0 - smoothstep(radius - 0.16, radius + 0.04, angle));
}

// Artistic analytic modes inspired by Faugeras et al., not a neural-field or
// bifurcation solver. Preserve legacy wave IDs: 0 rings, 1 rays, 2 spiral, 3 lattice.
// Result = S, dS/dx, dS/dy, chromatic phase. Derivatives include the log-polar Jacobian.
vec4 dreamCortical(vec2 p) {
  float eps = max(0.015, u_eccentricity);
  float r = length(p), safeR = max(r, 0.02);
  vec2 radial = p / safeR;
  vec2 angular = vec2(-p.y, p.x) / (safeR * safeR);
  float u = log(1.0 + r / eps);
  float v = atan(p.y, p.x + 1e-8);
  vec2 du = radial / (eps + r);
  float k = clamp(u_frequency, 1.0, 30.0);
  float m = max(1.0, round(k * 0.4));
  float t = u_time * u_speed + u_journey_warp.z * u_journey_warp.w * 9.0;
  float wave, hue;
  vec2 gradient;
  if (u_wave_mode == 0) {
    float phase = k * u - t;
    wave = cos(phase); gradient = -sin(phase) * k * du;
    hue = 0.55 * u - t * 0.25;
  } else if (u_wave_mode == 1) {
    float phase = m * v - t;
    wave = cos(phase); gradient = -sin(phase) * m * angular;
    hue = m * v - t * 0.25;
  } else if (u_wave_mode == 2) {
    float phase = k * u + m * v - t;
    wave = cos(phase); gradient = -sin(phase) * (k * du + m * angular);
    hue = 0.65 * u + m * v - t * 0.25;
  } else {
    // 120-degree interference. Quantized angular frequency closes the seam.
    float n = max(1.0, round(k * 0.5));
    float ku = 2.0 * n / sqrt(3.0);
    vec3 phases = vec3(ku * u, -0.5 * ku * u + n * v, -0.5 * ku * u - n * v) - t;
    vec3 c = cos(phases), s = sin(phases);
    wave = (c.x + c.y + c.z) / 3.0;
    gradient = (-ku * (s.x - 0.5 * s.y - 0.5 * s.z) * du - n * (s.y - s.z) * angular) / 3.0;
    hue = (c.x - c.y + c.z) * 1.2 - t * 0.18;
  }
  float envelope = smoothstep(0.0, 0.08, r);
  float slope = r > 0.0 && r < 0.08 ? 6.0 * (r / 0.08) * (1.0 - r / 0.08) / 0.08 : 0.0;
  gradient = gradient * envelope + wave * slope * radial;
  gradient /= max(1.0, length(gradient) / 12.0);
  return vec4(wave * envelope, gradient, hue * envelope);
}
vec2 dreamCorticalPoint(vec2 sphereUV) {
  float longitude = (sphereUV.x - 0.5) * 2.0 * PI;
  float latitude = (sphereUV.y - 0.5) * PI;
  return vec2(sin(longitude) * cos(latitude), sin(latitude));
}
vec3 dreamHueRotate(vec3 rgb, float phase) {
  // Rotate chroma around the luminance axis, then compress chroma into gamut.
  float y = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  vec2 chroma = vec2(rgb.r - y, rgb.b - y);
  float c = cos(phase), s = sin(phase);
  chroma = mat2(c, -s, s, c) * chroma;
  vec3 delta = vec3(chroma.x, -(0.2126 * chroma.x + 0.0722 * chroma.y) / 0.7152, chroma.y);
  vec3 room = mix(vec3(y), vec3(1.0 - y), greaterThan(delta, vec3(0.0)));
  vec3 ratios = room / max(abs(delta), vec3(1e-5));
  return vec3(y) + delta * min(1.0, min(ratios.x, min(ratios.y, ratios.z)));
}

// Relative depth carves a photo shell in each connected map cell. High depth
// is foreground: its intersection is closer, so it can occlude background.
// These fields are NOT signed distances. The tracer below never sphere-traces them.
const float DREAM_NEAR = 4.0;
const float DREAM_MIN_RADIUS = 0.8;
// Requested 24/12/18/22 room profiles are normalized to the established 18-unit
// grid. The origin retains Phase 1's exact photo shell and entrance projection.
vec3 dreamRoomProfile(ivec2 cell) {
  if (all(equal(cell, ivec2(0)))) return vec3(1.0);
  uint type = dreamHash(cell) % 4u;
  if (type == 0u) return vec3(24.0 / 18.0, 0.8, 1.0);
  if (type == 1u) return vec3(12.0 / 18.0, 1.0, 1.0);
  if (type == 2u) return vec3(1.0, 1.5, 0.65);
  return vec3(22.0 / 18.0, 1.2, 1.0);
}
vec4 dreamPassage(vec3 p) {
  vec2 w = dreamWarp(p.xz);
  ivec2 base = ivec2(floor(w / 18.0));
  vec4 nearest = vec4(-1e5, 0.5, 0.5, 0.0);
  for (int z = 0; z < 2; z++) for (int x = 0; x < 2; x++) {
    ivec2 cell = base + ivec2(x, z);
    float presence = all(equal(cell, ivec2(0))) ? 1.0 : smoothstep(1.5, 4.0, u_journey_distance);
    if (presence <= 0.0) continue;
    vec3 local = vec3(w.x - float(cell.x) * 18.0, p.y, w.y - float(cell.y) * 18.0);
    bool originCell = all(equal(cell, ivec2(0)));
    int slot = u_journey_room_mode == 1 ? (originCell ? -1 : journeyRoomSlot(cell)) : int(dreamHash(cell) % 4u);
    vec3 profile = dreamRoomProfile(cell);
    uint type = dreamHash(cell) % 4u;
    if (!originCell && type == 1u) {
      local.x += sin(local.z * 0.35) * 0.9;
      local.x *= 1.35;
    }
    local.y *= profile.z;
    float radius = length(local);
    // Inscribed-ball bound is strictly positive here; skip texture fetches.
    if (radius < DREAM_MIN_RADIUS * presence - 0.06) {
      if (DREAM_MIN_RADIUS * presence - radius > nearest.x)
        nearest = vec4(DREAM_MIN_RADIUS * presence - radius, 0.5, 0.5, float(slot));
      continue;
    }
    float outer = (DREAM_NEAR + (4.0 + clamp(u_depth_extrude, 0.0, 1.5) * 3.0) * profile.y) * profile.x * presence;
    if (radius > outer + 0.25) {
      if (outer - radius > nearest.x) nearest = vec4(outer - radius, 0.5, 0.5, float(slot));
      continue;
    }
    vec2 sphereUV = domeSphereUV(local);
    vec2 uv = domePhotoUV(sphereUV);
    float depth = u_journey_room_mode == 1 ? journeyRoomDepth(uv, slot) : journeyDepth(uv);
    float recess = !originCell && type == 2u ? pow(1.0 - depth, 1.7) : 1.0 - depth;
    float relief = recess * (4.0 + clamp(u_depth_extrude, 0.0, 1.5) * 3.0) * profile.y;
    float field = (DREAM_NEAR + relief) * profile.x * presence - radius;
    // Closed horizontal edges match the map; vertical passages remain available.
    if (!dreamBridge(cell)) field = min(field, 9.0 - local.x);
    if (!dreamBridge(cell - ivec2(1, 0))) field = min(field, 9.0 + local.x);
    if (field > nearest.x) nearest = vec4(field, sphereUV, float(slot));
  }
  return nearest;
}
float dreamInscribedStep(vec3 p) {
  vec2 w = dreamWarp(p.xz);
  vec2 cell = round(w / 18.0) * 18.0;
  float presence = all(equal(cell, vec2(0.0))) ? 1.0 : smoothstep(1.5, 4.0, u_journey_distance);
  // Warp has bounded slope (<1.26); divide the empty-ball bound accordingly.
  float inner = all(equal(cell, vec2(0.0))) ? 3.5 : DREAM_MIN_RADIUS;
  return max(0.0, inner * presence - length(vec3(w.x - cell.x, p.y, w.y - cell.y))) / 1.26;
}
float dreamExteriorStep(vec3 p) {
  vec2 w = dreamWarp(p.xz);
  vec2 cell = round(w / 18.0) * 18.0;
  float outer = (DREAM_NEAR + (4.0 + clamp(u_depth_extrude, 0.0, 1.5) * 3.0) * 1.5) * (24.0 / 18.0) / 0.65;
  // Outside every enclosing sphere, this is a conservative bound on the next
  // possible surface, including cells that are outside the four current probes.
  return max(0.0, length(vec3(w.x - cell.x, p.y, w.y - cell.y)) - outer) / 1.26;
}
// Bounded sampling + sign-change bracketing avoids the old abs(field) SDF jumps.
// A hard cap resolves depth edges; binary refinement determines the actual hit.
bool dreamTrace(vec3 origin, vec3 ray, out float travel, out vec4 surface) {
  travel = 0.0;
  surface = dreamPassage(origin);
  float signAtOrigin = surface.x < 0.0 ? -1.0 : 1.0;
  for (int i = 0; i < 224; i++) {
    float previous = travel;
    float stepSize = clamp(abs(surface.x) * 0.2, 0.006, 0.12);
    if (surface.x > 0.0) stepSize = max(stepSize, dreamInscribedStep(origin + ray * travel));
    else stepSize = max(stepSize, dreamExteriorStep(origin + ray * travel));
    travel += stepSize;
    surface = dreamPassage(origin + ray * travel);
    if (surface.x * signAtOrigin <= 0.0) {
      float lo = previous, hi = travel;
      for (int j = 0; j < 10; j++) {
        float mid = (lo + hi) * 0.5;
        vec4 probe = dreamPassage(origin + ray * mid);
        if (probe.x * signAtOrigin > 0.0) lo = mid; else hi = mid;
      }
      travel = (lo + hi) * 0.5;
      surface = dreamPassage(origin + ray * travel);
      return true;
    }
    if (abs(surface.x) < 0.002) return true;
    if (travel > 40.0) break;
  }
  return false;
}
vec3 dreamPhoto(vec2 uv, float motif) {
  uv = dreamMirror(uv);
  float pixels = mix(1024.0, 96.0, u_journey_retro);
  uv = mix(uv, (floor(uv * pixels) + 0.5) / pixels, u_journey_retro);
  vec3 source = texture(u_journey_anchor, uv).rgb;
  vec3 generated;
  if (motif < -0.5) generated = source;
  else if (motif < 0.5) generated = texture(u_journey_echo, uv).rgb;
  else if (motif < 1.5) generated = texture(u_journey_dream, uv).rgb;
  else if (motif < 2.5) generated = texture(u_journey_structure, uv).rgb;
  else generated = texture(u_journey_cavern, uv).rgb;
  return mix(generated, source, u_journey_faithfulness);
}
vec3 dreamGroundedPhoto(vec2 uv) {
  vec3 color = texture(u_journey_anchor, uv).rgb * u_journey_source_weight;
  color += texture(u_journey_echo, uv).rgb * u_journey_weights.x;
  color += texture(u_journey_dream, uv).rgb * u_journey_weights.y;
  color += texture(u_journey_structure, uv).rgb * u_journey_weights.z;
  color += texture(u_journey_cavern, uv).rgb * u_journey_weights.w;
  return color;
}
vec3 journeyGeometry(vec3 ray, vec3 background) {
  vec3 origin = vec3(u_journey_position.x, 0.0, u_journey_position.y) + u_journey_camera_offset;
  float travel;
  vec4 surface;
  if (!dreamTrace(origin, ray, travel, surface)) return background;
  vec2 uv = domePhotoUV(surface.yz);
  vec3 grounded = u_journey_room_mode == 1 ? dreamPhoto(uv, surface.w) : dreamGroundedPhoto(uv);
  float aperture = journeyAperture(ray);
  float intensity = aperture * (1.0 - u_journey_style.w);
  vec4 cortical = dreamCortical(dreamCorticalPoint(surface.yz));
  // Spatial gradient refraction and RGB dispersion use the same hit projection.
  vec2 gradient = cortical.yz * (0.0015 + u_edge_coupling * 0.0025);
  float detail = u_journey_style.x * intensity;
  vec2 neuralUV = vec2(uv.x, 1.0 - uv.y);
  float neural = texture(u_neural, neuralUV).r;
  vec2 warped = uv + gradient * (detail + u_gain) * aperture;
  warped += neural * u_neural_extrude * detail * vec2(0.075, -0.054);
  vec3 color = dreamPhoto(warped, surface.w);
  vec2 q = warped - 0.5;
  float amplitude = detail * (0.2 + u_journey_style.z * 0.35), total = 1.0;
  for (int i = 0; i < 3; i++) {
    q = abs(q) * (1.4 + u_journey_style.z * 0.35) - vec2(0.31, 0.28);
    color += dreamPhoto(q + 0.5, surface.w) * amplitude;
    total += amplitude; amplitude *= 0.55;
  }
  color /= total;
  vec2 split = gradient * (u_dispersion + u_journey_warp.w * 0.7) * (u_gain + detail + u_journey_warp.w) * (1.0 + u_journey_warp.w * 4.0);
  color.r = mix(color.r, dreamPhoto(warped + split, surface.w).r, u_dispersion * aperture);
  color.b = mix(color.b, dreamPhoto(warped - split, surface.w).b, u_dispersion * aperture);
  color = dreamHueRotate(color, cortical.w * intensity * (0.3 + u_journey_style.z));
  float bands = pow(0.5 + 0.5 * cortical.x, 8.0);
  color += color * bands * u_journey_depth_effects.z * detail;
  ivec2 hitCell = ivec2(round(dreamWarp((origin + ray * travel).xz) / 18.0));
  if (dreamHash(hitCell) % 4u == 3u && any(notEqual(hitCell, ivec2(0)))) {
    float contour = pow(0.5 + 0.5 * cos(journeyRoomDepth(uv, int(surface.w)) * 80.0), 18.0);
    color = color * (1.0 - intensity * 0.3) + vec3(0.08, 0.4, 0.48) * contour * intensity * 0.35;
  }
  color = mix(grounded, color, intensity);
  float fog = smoothstep(14.0, 40.0, travel) * u_journey_depth_effects.y * 0.3;
  return mix(color, grounded, fog);
}

// A photo-derived chamber overlays the moving depth scene. Both ends have zero
// strength, so departure and arrival resolve to the unchanged scene projection.
vec3 journeyWarpChamber(vec3 ray, vec3 destination) {
  if (u_journey_warp.x < 0.5) return destination;
  float t = u_journey_warp.y;
  vec3 forward = normalize(u_viewDir);
  vec3 right = cross(forward, vec3(0.0, 1.0, 0.0));
  if (length(right) < 1e-5) right = vec3(1.0, 0.0, 0.0);
  right = normalize(right);
  vec3 up = normalize(cross(right, forward));
  vec2 p = vec2(dot(ray, right), dot(ray, up)) / max(0.2, dot(ray, forward));
  float r = length(p), theta = atan(p.y, p.x + 1e-8);
  float u = log(1.0 + r / max(0.04, u_eccentricity));
  // Integral of the smooth surge: forward rotation never reverses on slowdown.
  float phase = u_journey_warp.z * 2.0 + 720.0 * (t*t*t/3.0 - t*t*t*t/2.0 + t*t*t*t*t/5.0);
  vec2 uv = vec2(theta / (2.0 * PI) + u * 0.08 + phase * 0.018, u * 0.28 - phase * 0.035);
  vec3 chamber = dreamPhoto(uv, float(u_journey_seed % 4u));
  vec2 split = vec2(0.012, 0.018) * u_journey_warp.w * (1.0 - u_journey_style.w);
  chamber.r = dreamPhoto(uv + split, float(u_journey_seed % 4u)).r;
  chamber.b = dreamPhoto(uv - split, float(u_journey_seed % 4u)).b;
  float rings = 0.5 + 0.5 * cos(u * 11.0 + theta * 5.0 - phase);
  chamber *= 0.8 + rings * 0.35;
  float strength = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.85, 1.0, t));
  chamber = mix(dreamPhoto(domePhotoUV(domeSphereUV(ray)), float(u_journey_seed % 4u)), chamber, 0.9 * (1.0 - u_journey_style.w));
  vec3 color = mix(destination, chamber, strength);
  float blossom = smoothstep(0.85, 1.0, t);
  float opening = 1.0 - smoothstep(blossom * 3.0 - 0.05, blossom * 3.0 + 0.12, r);
  color = mix(color, destination, opening * blossom);
  float rim = exp(-pow((r - blossom * 2.5) / 0.13, 2.0));
  float pulse = sin(PI * clamp((t - 0.85) / 0.15, 0.0, 1.0));
  color += (u_journey_palette + vec3(0.15, 0.25, 0.3)) * rim * pulse * 0.4;
  return clamp(color, 0.0, 1.0);
}
