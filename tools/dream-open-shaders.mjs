// Isolated additions to the approved dome shader; disabled paths stay exact.
function replace(source, from, to) {
  if (source.split(from).length !== 2)
    throw new Error("Review drift shader hook: " + from.slice(0, 65));
  return source.replace(from, () => to);
}
const uniforms = `
uniform float u_drift_active,u_drift_wave_mix,u_drift_phase,u_drift_wave_amount;
uniform int u_drift_wave_next,u_drift_arch_count;
uniform vec2 u_drift_mapping,u_drift_effect;
uniform vec4 u_drift_arches[3],u_drift_shapes[3];
`;
const waves = `
float driftAngular(float n,float theta,float t){
  float a=max(1.,floor(n)),b=max(1.,ceil(n));
  return mix(sin(a*theta-t),sin(b*theta-t),smoothstep(0.,1.,fract(n)));
}
float driftHoney(float n,float u,float theta,float t){
  float k=2.*n/sqrt(3.);
  return (cos(k*u-t)+cos(-.5*k*u+n*theta-t)+cos(-.5*k*u-n*theta-t))/3.;
}
float driftWave(vec2 uv,int mode){
  vec2 z=(uv-u_fovea)*u_aspect;float r=length(z),theta=atan(z.y,z.x+1e-7);
  float u=log(1.+r/max(.005,u_eccentricity)),t=u_drift_phase,env=smoothstep(0.,.025,r);
  if(mode==0)return sin(u_frequency*u-t);
  if(mode==1)return env*driftAngular(u_frequency*.5,theta,t);
  if(mode==2)return env*driftAngular(u_frequency*.4,theta,t-u_frequency*.75*u);
  float n=max(1.,u_frequency*.5);
  return env*mix(driftHoney(floor(n),u,theta,t),driftHoney(ceil(n),u,theta,t),smoothstep(0.,1.,fract(n)));
}
float corticalWave(vec2 uv){
  if(u_drift_active<.5)return corticalWaveOriginal(uv);
  float base=mix(corticalWaveOriginal(uv),driftWave(uv,u_wave_mode),u_drift_wave_amount);
  return mix(base,driftWave(uv,u_drift_wave_next),u_drift_wave_mix);
}
`;
const arches = `
vec3 driftArch(vec3 c,vec3 ray,vec4 arch,vec4 shape){
  if(arch.w<.001)return c;
  vec2 forward=vec2(sin(arch.z),-cos(arch.z)),right=vec2(cos(arch.z),sin(arch.z));
  float denom=dot(ray.xz,forward);if(abs(denom)<.0001)return c;
  float travel=dot(arch.xy-u_origin_position,forward)/denom;if(travel<.12||travel>50.)return c;
  vec2 p=u_origin_position+ray.xz*travel-arch.xy;float x=dot(p,right),y=ray.y*travel;
  float radius=shape.x*(1.+sin(u_time*.23+shape.w)*.025);
  x+=sin(y*1.4+u_time*.22+shape.w)*shape.z*.11;
  float edge=y>.12?abs(length(vec2(x,y-.12))-radius):abs(abs(x)-radius);
  float aa=max(fwidth(edge),.008),base=smoothstep(-1.4,-1.3,y);
  float frame=(1.-smoothstep(.035,.035+aa*2.,edge))*base,glow=exp(-edge*13.)*.16*base;
  float inside=(1.-smoothstep(radius-.08,radius,length(vec2(x,max(0.,y-.12)))))*base;
  vec2 uv=domeSphereUV(v_worldPos),warped=uv;
  if(shape.y<.5)warped=.5+(uv-.5)*(.78+.06*sin(u_time*.2));
  else if(shape.y<1.5)warped+=vec2(sin(y*3.-u_time*.5),cos(x*3.+u_time*.4))*.016;
  else if(shape.y<2.5)warped+=vec2(sin(y*5.+u_time*.3)*.006,0.);
  else warped=vec2(uv.x+.21+sin(u_time*.2)*.008,uv.y);
  vec3 through=originDigital(photo(warped),warped),hue=imageHue(through,vec3(.4,.5,.6));
  float rib=.6+.4*sin(y*12.-u_time*.4+shape.w);
  c=mix(c,through,inside*.62*arch.w);
  return mix(c,hueLuminance(hue,.76),min(.82,frame*(.55+.15*rib)+glow)*arch.w);
}
`;
export function extendOpenShader(source, fragment = false) {
  let result = replace(
    source,
    "uniform float u_time;",
    uniforms + "\nuniform float u_time;",
  );
  result = replace(
    result,
    "float corticalWave(vec2 uv) {",
    "float corticalWaveOriginal(vec2 uv) {",
  );
  result = replace(
    result,
    "float t = u_time * u_speed;",
    "float t = u_drift_active>.5?u_drift_phase:u_time*u_speed;",
  );
  // Insert after the complete original function, before its callers.
  const start = result.indexOf("float corticalWaveOriginal(vec2 uv) {"),
    brace = result.indexOf("{", start);
  let level = 1,
    end = brace + 1;
  while (level && end < result.length) {
    if (result[end] === "{") level++;
    if (result[end] === "}") level--;
    end++;
  }
  if (level) throw new Error("Incomplete cortical wave function");
  result = result.slice(0, end) + waves + result.slice(end);
  result = replace(
    result,
    "float cap=sin(uv.y*3.14159265);",
    `float cap=sin(uv.y*3.14159265);
  if(u_drift_active>.5){
    uv+=u_drift_mapping*cap;
    if(u_drift_effect.x>.5&&u_drift_effect.x<1.5)uv+=vec2(sin(uv.y*18.-u_time*.5),cos(uv.x*14.+u_time*.3))*.014*u_drift_effect.y*cap;
    if(u_drift_effect.x<.5&&u_drift_effect.x>-.5)uv=.5+(uv-.5)*(1.-.15*u_drift_effect.y);
    return uv;
  }`,
  );
  if (!fragment) return result;
  result = replace(
    result,
    "vec3 originWorld(vec3 base){",
    arches + "\nvec3 originWorld(vec3 base){",
  );
  result = replace(
    result,
    "if(u_origin_portal_on>.001){",
    "if(u_drift_active<.5&&u_origin_portal_on>.001){",
  );
  result = replace(
    result,
    "// A color-derived loading veil; the level floor remains visible beneath it.",
    `if(u_drift_active>.5){for(int i=0;i<3;i++){if(i>=u_drift_arch_count)break;c=driftArch(c,ray,u_drift_arches[i],u_drift_shapes[i]);}}
  // A color-derived loading veil; the level floor remains visible beneath it.`,
  );
  return result;
}
