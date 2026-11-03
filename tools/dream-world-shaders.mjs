// Additional spatial cues for the exploration page. The approved study keeps
// its existing program; only the world page enables these uniforms.
function replaceWorld(source, before, after) {
  if (source.split(before).length !== 2)
    throw new Error("Review world shader hook: " + before.slice(0, 55));
  return source.replace(before, () => after);
}
const worldUniforms = `
uniform float u_world_active;
uniform vec2 u_world_floor_offset;
uniform int u_world_gate_count;
uniform vec4 u_world_gates[4];
uniform vec4 u_world_landmark;
`;
const worldSurfaces = `
vec3 worldFold(vec3 c,vec3 ray,vec4 gate){
  vec2 forward=vec2(sin(gate.z),-cos(gate.z)),right=vec2(cos(gate.z),sin(gate.z));
  float denom=dot(ray.xz,forward);if(abs(denom)<.0001||gate.w<.001)return c;
  float travel=dot(gate.xy-u_origin_position,forward)/denom;if(travel<.1||travel>50.)return c;
  vec2 hit=u_origin_position+ray.xz*travel-gate.xy;float x=dot(hit,right),y=ray.y*travel;
  float radius=2.*(1.+sin(u_time*.28)*.012);
  float edge=y>.12?abs(length(vec2(x,y-.12))-radius):abs(abs(x)-radius);
  float aa=max(fwidth(edge),.008),frame=(1.-smoothstep(.055,.055+aa*2.,edge))*smoothstep(-1.4,-1.3,y);
  float glow=exp(-edge*12.)*.18*smoothstep(-1.4,-1.3,y);
  float interior=(1.-smoothstep(radius-.08,radius,length(vec2(x,max(0.,y-.12)))))*smoothstep(-1.35,-1.3,y);
  vec2 uv=domeSphereUV(v_worldPos);float fold=sin(y*2.+u_time*.35)*cos(x*1.7-u_time*.2);
  vec2 throughUV=uv+vec2(fold*.012,sin(x*2.)*.006);
  vec3 through=originDigital(photo(throughUV),throughUV),hue=imageHue(c,vec3(.4,.5,.6));
  c=mix(c,mix(c,through,.65),interior*.48*gate.w);
  return mix(c,hueLuminance(hue,.78),min(.85,frame*.70+glow)*gate.w);
}
vec3 worldLandmark(vec3 c,vec3 ray){
  if(u_world_landmark.w<.001)return c;
  float type=u_world_landmark.z;
  vec3 scale=type<.5?vec3(1.5,.3,1.5):type<1.5?vec3(.65,1.9,.65):type<2.5?vec3(1.6,.9,1.6):type<3.5?vec3(1.1,1.65,1.1):type<4.5?vec3(1.8,.32,1.8):vec3(.85);
  scale*=1.+sin(u_time*.25)*.025;
  vec3 center=vec3(u_world_landmark.x,-1.25+scale.y,u_world_landmark.y);
  vec3 eye=vec3(u_origin_position.x,0.,u_origin_position.y),o=(eye-center)/scale,d=ray/scale;
  float a=dot(d,d),b=dot(o,d),disc=b*b-a*(dot(o,o)-1.);if(disc<0.)return c;
  float travel=(-b-sqrt(disc))/a;if(travel<.08||travel>42.)return c;
  if(ray.y<-.01&&travel>-1.35/ray.y)return c;
  vec3 p=(eye+ray*travel-center)/scale,n=normalize(p/scale);
  float phi=atan(p.x,p.z),theta=acos(clamp(p.y,-1.,1.));
  float pattern=type<.5?sin(theta*16.-phi*2.+u_time*.25):type<1.5?sin(theta*12.+phi*3.-u_time*.3):type<2.5?cos(phi*6.+sin(theta*4.+u_time*.25))*sin(theta*8.):type<3.5?sin(theta*14.+abs(sin(phi*3.))*4.-u_time*.35):type<4.5?sin(theta*18.-phi*4.+u_time*.3):cos(phi*8.+theta*8.-u_time*.3);
  float line=pow(.5+.5*pattern,10.),rim=pow(1.-abs(dot(n,-ray)),2.);
  vec2 uv=domeSphereUV(v_worldPos+n*.35);vec3 pigment=originDigital(photo(uv),uv),hue=imageHue(pigment,vec3(.4,.5,.6));
  vec3 body=mix(pigment,hueLuminance(hue,.78),max(line*.65,rim*.45));
  return mix(c,body,(.18+line*.45+rim*.24)*u_world_landmark.w);
}
`;
export function extendWorldShader(source, fragment = false) {
  let result = replaceWorld(
    source,
    "uniform float u_origin_explore;",
    worldUniforms + "\nuniform float u_origin_explore;",
  );
  result = replaceWorld(
    result,
    "uv.x+=(u_origin_position.x*.007+sin(u_origin_position.y*.035)*.045)*cap;",
    "vec2 position=u_world_active>.5?24.*tanh(u_origin_position/24.):u_origin_position;\n  uv.x+=(position.x*.007+sin(position.y*.035)*.045)*cap;",
  );
  result = replaceWorld(
    result,
    "uv.y+=sin(u_origin_position.y*.045)*.055*cap;",
    "uv.y+=sin(position.y*.045)*.055*cap;",
  );
  if (!fragment) return result;
  result = replaceWorld(
    result,
    "vec3 originWorld(vec3 base){",
    worldSurfaces + "\nvec3 originWorld(vec3 base){",
  );
  result = replaceWorld(
    result,
    "vec2 p=u_origin_position+ray.xz*distance;",
    "vec2 p=u_origin_position+ray.xz*distance+u_world_floor_offset*u_world_active;",
  );
  result = replaceWorld(
    result,
    "if(u_origin_portal_on>.001){",
    "if(u_world_active<.5&&u_origin_portal_on>.001){",
  );
  result = replaceWorld(
    result,
    "// A color-derived loading veil; the level floor remains visible beneath it.",
    "if(u_world_active>.5){\n    for(int i=0;i<4;i++){if(i>=u_world_gate_count)break;c=worldFold(c,ray,u_world_gates[i]);}\n    c=worldLandmark(c,ray);\n  }\n  // A color-derived loading veil; the level floor remains visible beneath it.",
  );
  return result;
}
