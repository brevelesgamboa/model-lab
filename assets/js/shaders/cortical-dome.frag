#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_dream_360;
uniform sampler2D u_depth;
uniform sampler2D u_neural;
uniform sampler2D u_nca_texture;
uniform float u_edge_coupling;
uniform float u_dispersion;
uniform float u_nca_sheen;
uniform float u_photo_protection;
uniform vec3 u_viewPos;
#include <cortical-waves>
#include <dome-mapping>
in vec3 v_worldPos;
in vec3 v_normal;
in float v_waveVal;
out vec4 out_color;
float domeWave(vec2 uv) {
  float longitude = (uv.x - 0.5) * 2.0 * PI;
  float latitude = (uv.y - 0.5) * PI;
  return corticalWave(0.5 + 0.5 * vec2(sin(longitude) * cos(latitude), sin(latitude)));
}
float luminance(vec3 rgb) { return dot(rgb, vec3(0.2126, 0.7152, 0.0722)); }
vec3 sampleTextureSafe(vec2 uv) {
  if (u_mirrored_wrap == 1) {
    vec2 mUV = domePhotoUV(uv);
    vec2 ddx = dFdx(mUV);
    vec2 ddy = dFdy(mUV);
    if (abs(ddx.x) > 0.5) ddx.x -= sign(ddx.x);
    if (abs(ddy.x) > 0.5) ddy.x -= sign(ddy.x);
    return textureGrad(u_dream_360, mUV, ddx, ddy).rgb;
  }
  // u_mirrored_wrap == 0: full equirectangular panorama
  // Handle 180-degree meridian seam wrap with safe derivative filtering and bilateral cross-fade
  vec2 ddx = dFdx(uv);
  vec2 ddy = dFdy(uv);
  if (abs(ddx.x) > 0.5) ddx.x -= sign(ddx.x);
  if (abs(ddy.x) > 0.5) ddy.x -= sign(ddy.x);
  float seamDist = min(uv.x, 1.0 - uv.x);
  float blendWidth = 30.0 / 360.0;
  if (seamDist < blendWidth) {
    float t = smoothstep(0.0, blendWidth, seamDist);
    vec2 altUV = vec2(uv.x < 0.5 ? uv.x + 1.0 : uv.x - 1.0, uv.y);
    vec3 cA = textureGrad(u_dream_360, uv, ddx, ddy).rgb;
    vec3 cB = textureGrad(u_dream_360, altUV, ddx, ddy).rgb;
    return mix(cB, cA, 0.5 + 0.5 * t);
  }
  return textureGrad(u_dream_360, uv, ddx, ddy).rgb;
}
vec3 photo(vec2 uv) { return sampleTextureSafe(uv); }
void main() {
  vec3 eyeVec = u_viewPos - v_worldPos;
  vec3 toEye = length(eyeVec) > 1e-6 ? normalize(eyeVec) : -normalize(v_worldPos);
  vec3 N = normalize(v_normal);
  if (dot(N, toEye) < 0.0) N = -N;
  float facing = max(0.0, dot(N, toEye));
  vec2 uv = domeSphereUV(v_worldPos);

  float edgeCoupling = u_edge_coupling;
  float dispersionAmt = clamp(u_dispersion, 0.0, 1.0);

  vec2 texel = 1.0 / vec2(textureSize(u_dream_360, 0));
  float eps = 0.002;
  vec2 grad = vec2(
    domeWave(uv + vec2(eps, 0.0)) - domeWave(uv - vec2(eps, 0.0)),
    domeWave(uv + vec2(0.0, eps)) - domeWave(uv - vec2(0.0, eps))
  ) / (2.0 * eps);
  vec2 direction = length(grad) > 1e-6 ? normalize(grad) : (length(N.xy) > 1e-6 ? normalize(N.xy) : vec2(0.0, 1.0));
  vec2 edge = vec2(
    luminance(photo(uv + vec2(texel.x, 0.0))) - luminance(photo(uv - vec2(texel.x, 0.0))),
    luminance(photo(uv + vec2(0.0, texel.y))) - luminance(photo(uv - vec2(0.0, texel.y)))
  );
  vec2 refraction = u_gain * edgeCoupling * (direction * 0.008 + edge * 0.03) * v_waveVal;
  vec2 dispersion = direction * u_gain * (dispersionAmt * (0.012 + edgeCoupling * 0.008));

  vec3 color = vec3(
    photo(uv + refraction + dispersion).r,
    photo(uv + refraction).g,
    photo(uv + refraction - dispersion).b
  );
  float fresnel = pow(1.0 - facing, 3.0);
  vec3 rim = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + v_waveVal * 2.5 + u_time * 0.12);
  color += rim * fresnel * u_gain * 0.25;

  // Living Bio-Sheen & Contour Eruption
  vec2 mapped = domePhotoUV(uv);
  vec2 scalarUV = vec2(mapped.x, 1.0 - mapped.y);
  
  // Forward axis is (0, 0, -1); frontAlignment measures focal photo proximity
  vec3 dir = normalize(v_worldPos);
  float frontAlignment = dot(dir, vec3(0.0, 0.0, -1.0));
  
  // Photo core protection: computes elliptical distance in photo UV space
  // so the portrait core stays protected in both primary view and mirrored tiles
  float uvDist = length((mapped - vec2(0.5)) * vec2(1.0, 1.2));
  float protectVal = clamp(u_photo_protection, 0.0, 1.0);
  float coreRadius = mix(0.12, 0.75, protectVal);
  float photoMask = smoothstep(coreRadius - 0.18, coreRadius + 0.12, uvDist);
  
  // Forward focal cone receives enhanced clarity under high protection
  float focalClarity = smoothstep(0.2, 0.85, frontAlignment) * protectVal;
  float surroundFactor = clamp(photoMask * (1.0 - focalClarity * 0.75), 0.0, 1.0);
  
  // Depth contour gradient: detects silhouette boundaries and foreground edges
  float depthDX = texture(u_depth, scalarUV + vec2(0.006, 0.0)).r - texture(u_depth, scalarUV - vec2(0.006, 0.0)).r;
  float depthDY = texture(u_depth, scalarUV + vec2(0.0, 0.006)).r - texture(u_depth, scalarUV - vec2(0.0, 0.006)).r;
  float depthContour = smoothstep(0.03, 0.22, length(vec2(depthDX, depthDY)) * 4.0 + length(edge) * 2.5);
  
  // Inception neural feature activation
  float neuralVal = texture(u_neural, scalarUV).r;
  float neuralContour = smoothstep(0.18, 0.65, neuralVal);
  
  // Eruption mask: active in surround, selective along contours and neural features in photo
  float eruptionMask = clamp(surroundFactor + (depthContour * 0.85 + neuralContour * 0.65) * (1.0 - surroundFactor * 0.4), 0.0, 1.0);
  
  // Sample live NCA phenotype
  vec3 ncaColor = texture(u_nca_texture, scalarUV).rgb;
  float ncaLum = dot(ncaColor, vec3(0.299, 0.587, 0.114));
  
  float sheen = clamp(u_nca_sheen, 0.0, 1.0) * eruptionMask;
  if (sheen > 0.001) {
    vec3 bioVeins = ncaColor * (0.8 + ncaLum * 1.2);
    vec3 ncaDispersion = (N * 0.5 + 0.5) * ncaLum * 0.08;
    
    // Screen/soft blend prevents blowing out bright pixels to pure white:
    vec3 illuminated = color + (1.0 - color) * (bioVeins + ncaDispersion) * sheen * 0.75;
    color = mix(color, illuminated, sheen * 0.8);
    
    // Subtle membrane pigment tinting in dark/mid contours without crushing contrast
    color = mix(color, ncaColor * color * 1.5, sheen * (1.0 - ncaLum) * 0.35);
  }

  out_color = vec4(color, 1.0);
}
