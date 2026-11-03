// Add opt-in image travel/material/floor effects to the actual app shaders.
// The disabled path preserves their original main() and arithmetic.
import { RAIN_GLSL, IMAGE_COLOR_GLSL } from "./dream-drift-ascii-renderer.mjs";

function originReplace(source, before, after) {
  if (source.split(before).length !== 2)
    throw new Error(
      "Original dome shader changed; review extension: " + before.slice(0, 55),
    );
  return source.replace(before, () => after);
}
const originMapping = `
uniform float u_origin_explore;
uniform vec2 u_origin_position;
vec2 originTravelUV(vec2 uv){
  if(u_origin_explore<.5)return uv;
  // Smooth bounded travel, including at the poles and mirrored photo seams.
  // It shares the photo/depth projection, rather than sliding an overlay.
  float cap=sin(uv.y*3.14159265);
  uv.x+=(u_origin_position.x*.007+sin(u_origin_position.y*.035)*.045)*cap;
  uv.y+=sin(u_origin_position.y*.045)*.055*cap;
  return uv;
}
`;
const originMaterial = `
precision highp sampler2DArray;
uniform sampler2D u_origin_next;
uniform sampler2DArray u_origin_glyphs;
uniform float u_origin_mix,u_origin_neon,u_origin_hex,u_origin_corruption;
uniform float u_origin_floor,u_origin_negative,u_origin_portal_on,u_origin_portal_yaw,u_origin_warp,u_origin_glyph_count;
uniform vec2 u_origin_portal;
${RAIN_GLSL}
${IMAGE_COLOR_GLSL}
vec3 originSample(vec2 uv,vec2 dx,vec2 dy){return mix(textureGrad(u_dream_360,uv,dx,dy).rgb,textureGrad(u_origin_next,uv,dx,dy).rgb,u_origin_mix);}
`;
const originWorld = `
vec3 originDigital(vec3 base,vec2 sphereUV){
  if(u_origin_neon<=0.&&u_origin_hex<=0.)return base;
  vec3 hue=imageHue(base,vec3(.4,.5,.6));
  vec3 c=imageVibrance(base,1.+u_origin_neon*1.8);
  c=mix(c,1.-(1.-c)*(1.-hue*.18),u_origin_neon);
  if(u_origin_hex<=0.)return c;
  vec2 grid=vec2(416.,144.),uv=domePhotoUV(sphereUV),cell=floor(uv*grid),local=fract(uv*grid);
  vec2 dx=dFdx(uv),dy=dFdy(uv);dx.x-=round(dx.x);dy.x-=round(dy.x);
  float drift=sin(cell.y*.07+u_time*.28)*u_origin_corruption;
  vec2 center=(cell+.5+vec2(drift*2.,0.))/grid;
  vec3 sampleColor=originSample(center,dx,dy);
  float light=luminance(sampleColor),rain=rainSignal(cell,grid,u_time*1.8);
  float choice=clamp((light+rain*.17)*(u_origin_glyph_count-1.)+.65*sin(u_time*.30+cell.y*.02)+drift*2.,0.,u_origin_glyph_count-1.001);
  float a=floor(choice),ink=mix(textureGrad(u_origin_glyphs,vec3(local,a),dx*grid,dy*grid).r,textureGrad(u_origin_glyphs,vec3(local,min(a+1.,u_origin_glyph_count-1.)),dx*grid,dy*grid).r,smoothstep(0.,1.,fract(choice)));
  vec3 pigment=hueLuminance(imageHue(sampleColor,hue),mix(.83,.25,smoothstep(.12,.8,light)));
  vec3 woven=mix(max(c*.92,hue*.11),pigment,ink*.94);
  return mix(c,woven,u_origin_hex);
}
vec3 originWorld(vec3 base){
  if(u_origin_explore<.5)return base;
  vec3 ray=normalize(v_worldPos-u_viewPos),c=base;
  vec3 hue=imageHue(base,vec3(.4,.5,.6));
  // An open plane with a soft horizon: no strip edges, rails or collision walls.
  if(ray.y<-.012&&u_origin_floor>0.){
    float distance=-1.35/ray.y;
    vec2 p=u_origin_position+ray.xz*distance;
    vec2 coord=p/3.,d=abs(fract(coord-.5)-.5)/max(fwidth(coord),vec2(.001));
    float line=1.-min(min(d.x,d.y),1.);
    vec3 negative=mix(base,vec3(1.)-base,u_origin_negative);
    vec3 floorColor=mix(negative*.58+vec3(.025),hueLuminance(imageHue(negative,hue),.58),line*.35);
    float presence=(1.-smoothstep(17.,40.,distance))*(1.-smoothstep(-.22,-.015,ray.y));
    c=mix(c,floorColor,presence*u_origin_floor*.8);
  }
  // One optional image fold. It is a doorway in open space, not a boundary.
  if(u_origin_portal_on>.001){
    vec2 forward=vec2(sin(u_origin_portal_yaw),-cos(u_origin_portal_yaw)),right=vec2(cos(u_origin_portal_yaw),sin(u_origin_portal_yaw));
    float denom=dot(ray.xz,forward);
    if(abs(denom)>.0001){
      float travel=dot(u_origin_portal-u_origin_position,forward)/denom;
      if(travel>.1&&travel<45.){
        vec2 hit=u_origin_position+ray.xz*travel-u_origin_portal;
        float x=dot(hit,right),y=ray.y*travel;
        float breath=1.+sin(u_time*.28)*.012;
        float radius=2.*breath;
        float edge=y>.12?abs(length(vec2(x,y-.12))-radius):abs(abs(x)-radius);
        float aa=max(fwidth(edge),.008),frame=(1.-smoothstep(.055,.055+aa*2.,edge))*smoothstep(-1.4,-1.3,y);
        float glow=exp(-edge*12.)*.18*smoothstep(-1.4,-1.3,y);
        float interior=(1.-smoothstep(radius-.08,radius,length(vec2(x,max(0.,y-.12)))))*smoothstep(-1.35,-1.3,y);
        vec2 uv=domeSphereUV(v_worldPos);
        float fold=sin(y*2.+u_time*.35)*cos(x*1.7-u_time*.2);
        vec3 through=photo(uv+vec2(fold*.012,sin(x*2.)*.006));
        c=mix(c,mix(base,through,.65),interior*.48*u_origin_portal_on);
        c=mix(c,hueLuminance(hue,.78),min(.85,frame*.70+glow)*u_origin_portal_on);
      }
    }
  }
  // A color-derived loading veil; the level floor remains visible beneath it.
  c=mix(c,mix(c,hueLuminance(hue,.55),.5),u_origin_warp*.55);
  return c;
}
`;

export function extendOriginShader(source, fragment = false) {
  let result = originReplace(
    source,
    "uniform int u_mirrored_wrap;",
    "uniform int u_mirrored_wrap;\n" + originMapping,
  );
  result = originReplace(
    result,
    "vec2 domePhotoUV(vec2 sphereUV) {",
    "vec2 domePhotoUV(vec2 sphereUV) {\n  sphereUV=originTravelUV(sphereUV);",
  );
  if (!fragment) return result;
  result = originReplace(
    result,
    "vec3 sampleTextureSafe(vec2 uv) {",
    originMaterial + "\nvec3 sampleTextureSafe(vec2 uv) {",
  );
  result = originReplace(
    result,
    "return textureGrad(u_dream_360, mUV, ddx, ddy).rgb;",
    "return originSample(mUV,ddx,ddy);",
  );
  result = originReplace(
    result,
    "vec3 cA = textureGrad(u_dream_360, uv, ddx, ddy).rgb;",
    "vec3 cA = originSample(uv,ddx,ddy);",
  );
  result = originReplace(
    result,
    "vec3 cB = textureGrad(u_dream_360, altUV, ddx, ddy).rgb;",
    "vec3 cB = originSample(altUV,ddx,ddy);",
  );
  result = originReplace(
    result,
    "return textureGrad(u_dream_360, uv, ddx, ddy).rgb;",
    "return originSample(uv,ddx,ddy);",
  );
  result = originReplace(
    result,
    "void main() {",
    originWorld + "\nvoid main() {",
  );
  result = originReplace(
    result,
    "if (u_swap_rb > 0.5) color = color.bgr;",
    "color=originDigital(color,uv+refraction);\n  color=originWorld(color);\n  if (u_swap_rb > 0.5) color = color.bgr;",
  );
  // The disabled path samples the original texture directly, avoiding even mix
  // rounding in the identity comparison on drivers that lower mix differently.
  result = result.replace(
    "return mix(textureGrad(u_dream_360,uv,dx,dy).rgb,",
    "if(u_origin_mix<=0.)return textureGrad(u_dream_360,uv,dx,dy).rgb;return mix(textureGrad(u_dream_360,uv,dx,dy).rgb,",
  );
  return result;
}
