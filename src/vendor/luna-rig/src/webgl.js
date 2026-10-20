import { barycentric, smoothstep } from "./math.js";
import { poseInterval } from "./pose-art.js";
import { garmentFrame, garmentCoordinates } from "./garment-chart.js";
import {
  clothChartParameters,
  clothMaterialCoordinates,
} from "./cloth-chart.js";
import {
  cuffChartParameters,
  cuffMatrix,
  cuffMaterialCoordinates,
  forearmMouthCoverage,
} from "./cuff-chart.js";

const vertexSource = `attribute vec2 a_position; attribute vec2 a_uv; uniform vec2 u_resolution; varying vec2 v_uv; varying vec2 v_canvasPoint;
void main(){ vec2 p = a_position/u_resolution*2.0-1.0; gl_Position=vec4(p.x,-p.y,0.0,1.0); v_uv=a_uv; v_canvasPoint=a_position; }`;
const fragmentSource = `precision highp float;
uniform sampler2D u_texture; uniform sampler2D u_second;
uniform sampler2D u_distanceA; uniform sampler2D u_distanceB;
uniform sampler2D u_layerMask; uniform float u_layerMaskMode; uniform float u_layerMaskMorph;
uniform float u_materialCategory;
uniform sampler2D u_roundTexture; uniform sampler2D u_roundDistance; uniform float u_roundMouth;
uniform float u_dualColour; uniform float u_opacity; uniform float u_mix; uniform float u_morph; uniform float u_contourBias; uniform float u_contourAA; uniform float u_eyeClosure; uniform float u_clipFrom; uniform float u_eyeSurface; uniform float u_eyeLift;
uniform float u_aperture;
uniform float u_nativeCoverage;
uniform float u_premultipliedMorph; uniform vec3 u_morphColour;
uniform float u_morphKind;
uniform float u_materialFlowScale;
uniform float u_surfaceReveal;
uniform float u_poseKey; uniform vec2 u_poseFlowCellSize;
uniform vec4 u_frontDepth; uniform float u_frontCut; uniform float u_frontPass;
uniform float u_clothChart; uniform vec4 u_clothFrame; uniform vec4 u_clothRect;
uniform vec3 u_clothCurrent; uniform vec3 u_clothFirst; uniform vec3 u_clothSecond;
uniform float u_clothMirror;
uniform float u_cuffChart; uniform mat3 u_cuffInverse; uniform mat3 u_cuffFirst; uniform mat3 u_cuffSecond;
uniform vec4 u_handDepth; uniform float u_forearmClip; uniform vec4 u_forearmBone;
uniform float u_forearmWidth; uniform float u_forearmExit;
uniform vec4 u_inkRoot;
uniform vec2 u_maskOrigin; uniform vec2 u_maskU; uniform vec2 u_maskV;
uniform vec4 u_maskCurve;
uniform sampler2D u_profileTexture; uniform float u_maskProfile; uniform float u_profileSize;
varying vec2 v_uv; varying vec2 v_canvasPoint;
float signedDistance(vec4 sampleValue){return (sampleValue.r*65280.0+sampleValue.g*255.0-32768.0)/32.0;}
vec4 poseFlow(float frame,float view){
  vec2 cell=vec2(mod(frame,3.0)+view*3.0,floor(frame/3.0));
  vec2 uv=clamp(v_uv,.5/u_poseFlowCellSize,1.0-.5/u_poseFlowCellSize);
  return texture2D(u_roundDistance,(cell+uv)/vec2(6.0,3.0));
}
vec2 decodePoseFlow(vec4 data){return (vec2(data.r*65280.0+data.g*255.0,data.b*65280.0+data.a*255.0)-32768.0)/32767.0*u_materialFlowScale;}
vec2 clothRotate(vec2 p,float angle){float c=cos(angle),s=sin(angle);return vec2(p.x*c-p.y*s,p.x*s+p.y*c);}
float clothGravity(float v){float t=clamp((v-38.0)/47.0,0.0,1.0);return v>=85.0?v-61.5:47.0*(t*t*t-0.5*t*t*t*t);}
vec2 clothInverse(vec2 point,vec3 frame){
  vec2 q=clothRotate(point-u_clothFrame.xy,-frame.x);
  float c=cos(frame.x),s=sin(frame.x),v=q.y;
  float top=85.0+(c-1.0)*23.5;
  if(q.y>=top)v=(q.y-(1.0-c)*61.5)/c;
  else if(q.y>38.0){
    float lo=38.0,hi=85.0;v=mix(lo,hi,(q.y-38.0)/(top-38.0));
    for(int i=0;i<10;i++){
      float e=v+(c-1.0)*clothGravity(v)-q.y;
      if(abs(e)<0.00001)break;
      if(e>0.0)hi=v;else lo=v;
      float n=v-e/(1.0+(c-1.0)*smoothstep(38.0,85.0,v));
      v=n>lo&&n<hi?n:0.5*(lo+hi);
    }
  }
  float a=q.x-s*clothGravity(v),limit=u_clothFrame.z-22.0,u=a;
  if(a>=limit+frame.y)u=a-frame.y;
  else if(a>0.0){
    float lo=0.0,hi=limit;u=limit*a/(limit+frame.y);
    for(int i=0;i<10;i++){
      float t=u/limit,e=u+frame.y*smoothstep(0.0,limit,u)-a;
      if(abs(e)<0.00001)break;
      if(e>0.0)hi=u;else lo=u;
      float n=u-e/(1.0+frame.y*6.0*t*(1.0-t)/limit);
      u=n>lo&&n<hi?n:0.5*(lo+hi);
    }
  }
  return clothRotate(vec2(u,v),frame.z);
}
vec2 clothForward(vec2 point,vec3 frame){
  vec2 q=clothRotate(point,-frame.z);
  float hanging=clothGravity(q.y);
  q.x+=frame.y*smoothstep(0.0,u_clothFrame.z-22.0,q.x)+sin(frame.x)*hanging;
  q.y+=(cos(frame.x)-1.0)*hanging;
  return u_clothFrame.xy+clothRotate(q,frame.x);
}
void main(){
  vec2 nativeUV=v_uv,posedUV=v_uv;
  if(u_mix<0.00001 || u_mix>0.99999){
    // Native endpoints already share the current chart. The idle model must
    // not solve two inverse cloth maps for every transparent fragment.
  }else if(u_cuffChart>0.5){
    vec2 point=u_clothRect.xy+v_uv*u_clothRect.zw;
    if(u_clothMirror>0.0)point.x=u_clothMirror-point.x;
    vec3 q=u_cuffInverse*vec3(point,1.0);
    vec2 a=(u_cuffFirst*q).xy,b=(u_cuffSecond*q).xy;
    if(u_clothMirror>0.0){a.x=u_clothMirror-a.x;b.x=u_clothMirror-b.x;}
    nativeUV=(a-u_clothRect.xy)/u_clothRect.zw;posedUV=(b-u_clothRect.xy)/u_clothRect.zw;
    if(u_mix<0.00001)nativeUV=v_uv;if(u_mix>0.99999)posedUV=v_uv;
  }else if(u_clothChart>0.5){
    vec2 point=u_clothRect.xy+v_uv*u_clothRect.zw;
    if(u_clothMirror>0.0)point.x=u_clothMirror-point.x;
    vec2 canonical=clothInverse(point,u_clothCurrent);
    vec2 a=clothForward(canonical,u_clothFirst),b=clothForward(canonical,u_clothSecond);
    if(u_clothMirror>0.0){a.x=u_clothMirror-a.x;b.x=u_clothMirror-b.x;}
    nativeUV=(a-u_clothRect.xy)/u_clothRect.zw;
    posedUV=(b-u_clothRect.xy)/u_clothRect.zw;
    if(u_mix<0.00001)nativeUV=v_uv;
    if(u_mix>0.99999)posedUV=v_uv;
  }else if(u_poseKey>0.5){
    float frame=u_mix*8.0,firstFrame=floor(frame),secondFrame=min(8.0,firstFrame+1.0);
    vec2 a=decodePoseFlow(mix(poseFlow(firstFrame,0.0),poseFlow(secondFrame,0.0),fract(frame)));
    vec2 b=decodePoseFlow(mix(poseFlow(firstFrame,1.0),poseFlow(secondFrame,1.0),fract(frame)));
    nativeUV=v_uv+a; posedUV=v_uv+b;
    if(u_mix<0.00001)nativeUV=v_uv;
    if(u_mix>0.99999)posedUV=v_uv;
  }else if(u_materialFlowScale>0.0){
    for(int i=0;i<3;i++){
      vec2 a=(texture2D(u_roundDistance,nativeUV).rg-.5)*u_materialFlowScale;
      vec2 b=(texture2D(u_roundDistance,posedUV).ba-.5)*u_materialFlowScale;
      nativeUV=v_uv-u_mix*a;
      posedUV=v_uv-(1.0-u_mix)*b;
    }
  }
  vec4 colour=texture2D(u_texture,nativeUV);
  if(u_dualColour>0.5)colour=mix(colour,texture2D(u_second,v_uv),u_mix);
  if(u_morph>0.5){
    if(u_premultipliedMorph>0.5 && u_roundMouth*(1.0-u_mix)<0.00001 && u_mix<0.00001){
      // Exact native RGBA: no distance textures, interpolation or inpainting.
    }else if(u_premultipliedMorph>0.5 && u_mix>0.99999){
      colour=texture2D(u_second,posedUV);
    }else{
    vec4 first=colour, second=texture2D(u_second,posedUV);
    colour=mix(colour,second,u_mix);
    vec4 distanceA=texture2D(u_distanceA,nativeUV),distanceB=texture2D(u_distanceB,posedUV);
    float distance=mix(signedDistance(distanceA),signedDistance(distanceB),u_mix);
    vec4 visibility=texture2D(u_roundDistance,v_uv);
    if(u_surfaceReveal<0.99999)distance=mix(signedDistance(visibility),distance,u_surfaceReveal);
    float roundAmount=u_roundMouth*(1.0-u_mix);
    vec4 rounded=texture2D(u_roundTexture,nativeUV);
    if(roundAmount>0.00001)distance=mix(distance,signedDistance(texture2D(u_roundDistance,v_uv)),roundAmount);
    float aa=u_contourAA;
#ifdef HAS_DERIVATIVES
    aa=max(0.7,0.5*fwidth(distance));
#endif
    float alpha=smoothstep(-aa,aa,distance+u_contourBias);
    if(u_nativeCoverage>0.5 && roundAmount<0.00001 && u_surfaceReveal>0.99999){
      float native=u_mix<0.5?distanceA.b:distanceB.b;
      alpha=mix(native,alpha,smoothstep(0.0,0.12,min(u_mix,1.0-u_mix)));
    }
    if(u_premultipliedMorph>0.5){
      vec3 a=first.a>0.03?first.rgb/max(first.a,0.001):(second.a>0.03?second.rgb/max(second.a,0.001):u_morphColour);
      vec3 b=second.a>0.03?second.rgb/max(second.a,0.001):a;
      vec3 paint=mix(a,b,u_mix);
      if(roundAmount>0.00001)paint=mix(paint,rounded.a>0.01?rounded.rgb/max(rounded.a,0.001):u_morphColour,roundAmount);
      if(u_morphKind>1.5 && u_morphKind<3.5){
        // Source contours define the anatomy. Old occlusion lines inside a
        // material must not become a second red finger through its surface.
        // Complete dorsal skin replaces baked contact lines as the fingers
        // separate. The native endpoint is still returned byte-for-byte below.
        vec3 dorsal=rounded.a>0.5?rounded.rgb/max(rounded.a,0.001):a;
        if(b.r<0.90 || b.g<0.74)b=dorsal;
        vec3 skin=mix(dorsal,b,u_mix);
        float root=u_inkRoot.x+dot(u_inkRoot.yz,v_uv);
        float edge=(u_morphKind<2.5?1.0:0.0)*(1.0-smoothstep(0.5,3.0,distance));
        if(u_inkRoot.w>0.5)edge*=smoothstep(-0.05,0.23,root);
        vec3 clean=mix(skin,vec3(0.84,0.54,0.59),edge);
        float interior=smoothstep(0.0,0.01,u_mix)*smoothstep(0.0,0.1,1.0-u_mix);
        paint=mix(paint,clean,interior);
      }
      if(u_morphKind>3.5 && u_poseKey<0.5){
        vec3 complete=rounded.rgb/max(rounded.a,0.001);
        vec3 moving=mix(complete,second.a>0.01?second.rgb/max(second.a,0.001):complete,u_mix);
        paint=mix(paint,moving,smoothstep(0.0,0.015,u_mix));
      }
      if(u_poseKey>0.5)paint=mix(rounded.rgb,texture2D(u_profileTexture,posedUV).rgb,u_mix);
      colour=vec4(paint*alpha,alpha);
      if(roundAmount<0.00001 && u_mix<0.00001)colour=first;
      if(roundAmount<0.00001 && u_mix>0.99999)colour=second;
      if(roundAmount>0.99999)colour=rounded;
    }else colour=vec4(colour.rgb*alpha,alpha);
    }
  }
  if(u_eyeSurface>0.5){
    float curve=(2.0*v_uv.x-1.0)*(2.0*v_uv.x-1.0);
    float closed=0.75-0.30*curve-0.14*u_eyeLift;
    float top=mix(0.12+0.33*curve,closed,u_eyeClosure);
    float bottom=mix(0.98-0.4*curve,closed,u_eyeClosure);
    float coverage=smoothstep(top-0.015,top+0.015,v_uv.y)*(1.0-smoothstep(bottom-0.015,bottom+0.015,v_uv.y));
    colour*=coverage*(1.0-smoothstep(0.9,1.0,u_eyeClosure));
  }
  if(u_clipFrom>0.0)colour*=smoothstep(u_clipFrom-0.015,u_clipFrom+0.015,v_uv.y);
  if(u_handDepth.w>0.5){
    float side=step(0.0,u_handDepth.x+dot(u_handDepth.yz,v_uv));
    colour*=u_handDepth.w>1.5?1.0-side:side;
  }
  if(u_forearmClip>0.5){
    float along=v_uv.y*u_forearmBone.w,across=(v_uv.x-.5)*u_forearmWidth;
    vec2 axis=vec2(cos(u_forearmBone.z),sin(u_forearmBone.z));
    vec2 point=u_forearmBone.xy+axis*along+vec2(-axis.y,axis.x)*across;
    vec2 q=(u_cuffInverse*vec3(point,1.0)).xy;
    float inside=1.0-smoothstep(.82,.91,length(q));
    colour*=max(inside,smoothstep(u_forearmExit-3.0,u_forearmExit+3.0,along));
  }
  if(u_aperture>0.5){
    vec2 point=v_canvasPoint-u_maskOrigin;
    float u=dot(point,u_maskU),y=dot(point,u_maskV);
    float arch=4.0*u*(1.0-u),base=u_maskCurve.x*u;
    float upper=base+u_maskCurve.y*arch,lower=base+u_maskCurve.z*arch;
    if(u_maskProfile>0.5){
      vec4 profile=texture2D(u_profileTexture,vec2((.5+clamp(u,0.0,1.0)*(u_profileSize-1.0))/u_profileSize,.5));
      upper=(profile.r*65280.0+profile.g*255.0-32768.0)/512.0;
      lower=(profile.b*65280.0+profile.a*255.0-32768.0)/512.0;
    }
    float aa=u_maskCurve.w;
#ifdef HAS_DERIVATIVES
    aa=max(0.001,0.5*max(fwidth(y-upper),fwidth(y-lower)));
#endif
    float coverage=smoothstep(upper-aa,upper+aa,y)*(1.0-smoothstep(lower-aa,lower+aa,y));
    coverage*=step(0.0,u)*step(u,1.0)*smoothstep(0.0,aa,lower-upper);
    colour*=coverage;
  }
  if(u_layerMaskMode>0.5){
    vec4 firstMask=texture2D(u_layerMask,nativeUV),secondMask=texture2D(u_layerMask,posedUV);
    float firstDepth=firstMask.r;
    float secondDepth=secondMask.g;
    float coverage=step(0.5,mix(firstDepth,secondDepth,u_layerMaskMorph*u_mix));
    if(u_materialCategory>-0.5){
      float cuff=step(0.5,mix(firstMask.b,secondMask.a,u_mix));
      coverage=u_materialCategory<0.5?1.0-cuff:(u_materialCategory<1.5?cuff*(1.0-coverage):cuff*coverage);
      colour*=coverage;
    }else colour*=u_layerMaskMode>1.5?1.0-coverage:coverage;
  }
  if(u_frontPass>0.5){
    float depth=dot(v_canvasPoint-u_frontDepth.xy,u_frontDepth.zw);
    float coverage=smoothstep(u_frontCut-0.45,u_frontCut+0.45,depth);
    colour*=u_frontPass>1.5?1.0-coverage:coverage;
  }
  gl_FragColor=colour*u_opacity;
}`;

function shader(gl, type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(error);
  }
  return s;
}

function filterColour(gl, image) {
  if (
    (image.width & (image.width - 1)) === 0 &&
    (image.height & (image.height - 1)) === 0
  ) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR,
    );
  }
}

function sampleChannel(data, width, height, u, v, channel) {
  const x = Math.max(0, Math.min(width - 1, u * width - 0.5)),
    y = Math.max(0, Math.min(height - 1, v * height - 0.5)),
    a = Math.floor(x),
    b = Math.floor(y),
    c = Math.min(width - 1, a + 1),
    d = Math.min(height - 1, b + 1),
    tx = x - a,
    ty = y - b;
  return (
    (data[(b * width + a) * 4 + channel] * (1 - tx) +
      data[(b * width + c) * 4 + channel] * tx) *
      (1 - ty) +
    (data[(d * width + a) * 4 + channel] * (1 - tx) +
      data[(d * width + c) * 4 + channel] * tx) *
      ty
  );
}

export function materialCoordinates(sprite, u, v) {
  let a = [u, v],
    b = [u, v];
  if (sprite.garmentCurrent) {
    const result = garmentCoordinates(sprite, u, v);
    if (sprite.mix < 0.00001) result[0] = a;
    if (sprite.mix > 0.99999) result[1] = b;
    return result;
  }
  if (sprite.cuffCurrent && !sprite.registeredGarment) {
    const result = cuffMaterialCoordinates(sprite, u, v);
    if (sprite.mix < 0.00001) result[0] = a;
    if (sprite.mix > 0.99999) result[1] = b;
    return result;
  }
  if (sprite.clothCurrent) {
    const result = clothMaterialCoordinates(sprite, u, v);
    if (sprite.mix < 0.00001) result[0] = a;
    if (sprite.mix > 0.99999) result[1] = b;
    return result;
  }
  if (sprite.poseKey && sprite.materialFlowPixels) {
    const frame = (sprite.mix || 0) * 8,
      i = Math.floor(frame),
      next = Math.min(8, i + 1),
      amount = frame - i;
    const sample = (n, channel, view) => {
      const width = sprite.materialFlowWidth / 6,
        height = sprite.materialFlowHeight / 3;
      const x =
        ((n % 3) +
          view * 3 +
          Math.max(0.5 / width, Math.min(1 - 0.5 / width, u))) /
        6;
      const y =
        (Math.floor(n / 3) +
          Math.max(0.5 / height, Math.min(1 - 0.5 / height, v))) /
        3;
      return sampleChannel(
        sprite.materialFlowPixels,
        sprite.materialFlowWidth,
        sprite.materialFlowHeight,
        x,
        y,
        channel,
      );
    };
    const shifts = Array.from({ length: 4 }, (_, c) => {
      const view = Math.floor(c / 2),
        channel = (c % 2) * 2;
      const first =
        sample(i, channel, view) * 256 + sample(i, channel + 1, view);
      const second =
        sample(next, channel, view) * 256 + sample(next, channel + 1, view);
      return (
        ((first * (1 - amount) + second * amount - 32768) / 32767) *
        sprite.materialFlowScale
      );
    });
    if (sprite.mix > 0.00001) a = [u + shifts[0], v + shifts[1]];
    if (sprite.mix < 0.99999) b = [u + shifts[2], v + shifts[3]];
  } else if (sprite.materialFlowScale && sprite.materialFlowPixels) {
    const sample = (point, channel) =>
      (sampleChannel(
        sprite.materialFlowPixels,
        sprite.materialFlowWidth,
        sprite.materialFlowHeight,
        ...point,
        channel,
      ) /
        255 -
        0.5) *
      sprite.materialFlowScale;
    for (let k = 0; k < 3; k++) {
      a = [u - sprite.mix * sample(a, 0), v - sprite.mix * sample(a, 1)];
      b = [
        u - (1 - sprite.mix) * sample(b, 2),
        v - (1 - sprite.mix) * sample(b, 3),
      ];
    }
  }
  return [a, b];
}

export class WebGLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = (this.gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    }));
    if (!gl)
      throw new Error(
        "WebGL недоступен. Включите аппаратное ускорение или откройте студию в другом браузере.",
      );
    this.program = gl.createProgram();
    const derivatives = gl.getExtension("OES_standard_derivatives");
    const fragment =
      (derivatives
        ? "#extension GL_OES_standard_derivatives : enable\n#define HAS_DERIVATIVES\n"
        : "") + fragmentSource;
    const vs = shader(gl, gl.VERTEX_SHADER, vertexSource),
      fs = shader(gl, gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(this.program));
    gl.useProgram(this.program);
    this.position = gl.getAttribLocation(this.program, "a_position");
    this.uv = gl.getAttribLocation(this.program, "a_uv");
    this.resolution = gl.getUniformLocation(this.program, "u_resolution");
    this.opacity = gl.getUniformLocation(this.program, "u_opacity");
    this.mix = gl.getUniformLocation(this.program, "u_mix");
    this.dualColour = gl.getUniformLocation(this.program, "u_dualColour");
    this.morph = gl.getUniformLocation(this.program, "u_morph");
    this.contourBias = gl.getUniformLocation(this.program, "u_contourBias");
    this.contourAA = gl.getUniformLocation(this.program, "u_contourAA");
    this.eyeClosure = gl.getUniformLocation(this.program, "u_eyeClosure");
    this.clipFrom = gl.getUniformLocation(this.program, "u_clipFrom");
    this.eyeSurface = gl.getUniformLocation(this.program, "u_eyeSurface");
    this.eyeLift = gl.getUniformLocation(this.program, "u_eyeLift");
    this.aperture = gl.getUniformLocation(this.program, "u_aperture");
    this.nativeCoverage = gl.getUniformLocation(
      this.program,
      "u_nativeCoverage",
    );
    this.premultipliedMorph = gl.getUniformLocation(
      this.program,
      "u_premultipliedMorph",
    );
    this.morphColour = gl.getUniformLocation(this.program, "u_morphColour");
    this.morphKind = gl.getUniformLocation(this.program, "u_morphKind");
    this.materialFlowScale = gl.getUniformLocation(
      this.program,
      "u_materialFlowScale",
    );
    this.surfaceReveal = gl.getUniformLocation(this.program, "u_surfaceReveal");
    this.poseKey = gl.getUniformLocation(this.program, "u_poseKey");
    this.frontDepth = gl.getUniformLocation(this.program, "u_frontDepth");
    this.frontCut = gl.getUniformLocation(this.program, "u_frontCut");
    this.frontPass = gl.getUniformLocation(this.program, "u_frontPass");
    this.clothUniforms = Object.fromEntries(
      ["Chart", "Frame", "Rect", "Current", "First", "Second", "Mirror"].map(
        (name) => [name, gl.getUniformLocation(this.program, "u_cloth" + name)],
      ),
    );
    this.cuffUniforms = Object.fromEntries(
      ["Chart", "Inverse", "First", "Second"].map((name) => [
        name,
        gl.getUniformLocation(this.program, "u_cuff" + name),
      ]),
    );
    this.handDepth = gl.getUniformLocation(this.program, "u_handDepth");
    this.forearmUniforms = Object.fromEntries(
      ["Clip", "Bone", "Width", "Exit"].map((name) => [
        name,
        gl.getUniformLocation(this.program, "u_forearm" + name),
      ]),
    );
    this.poseFlowCellSize = gl.getUniformLocation(
      this.program,
      "u_poseFlowCellSize",
    );
    this.materialCategory = gl.getUniformLocation(this.program, "u_materialCategory");
    this.layerMaskMorph = gl.getUniformLocation(
      this.program,
      "u_layerMaskMorph",
    );
    this.inkRoot = gl.getUniformLocation(this.program, "u_inkRoot");
    this.layerMaskMode = gl.getUniformLocation(this.program, "u_layerMaskMode");
    this.roundMouth = gl.getUniformLocation(this.program, "u_roundMouth");
    this.maskOrigin = gl.getUniformLocation(this.program, "u_maskOrigin");
    this.maskU = gl.getUniformLocation(this.program, "u_maskU");
    this.maskV = gl.getUniformLocation(this.program, "u_maskV");
    this.maskCurve = gl.getUniformLocation(this.program, "u_maskCurve");
    this.maskProfile = gl.getUniformLocation(this.program, "u_maskProfile");
    this.profileSize = gl.getUniformLocation(this.program, "u_profileSize");
    this.profileTextures = new Map();
    gl.uniform1i(gl.getUniformLocation(this.program, "u_profileTexture"), 4);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_texture"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_second"), 1);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_distanceA"), 2);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_distanceB"), 3);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_layerMask"), 5);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_roundTexture"), 6);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_roundDistance"), 7);
    gl.enable(gl.BLEND);
    gl.disable(gl.DITHER);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    this.resources = [];
    this.drawCalls = 0;
  }
  makeSprite(
    image,
    rect,
    {
      columns = 6,
      rows = 10,
      name = "",
      zone = null,
      raw = false,
      mipmaps = true,
      nativeCoverage = false,
      nativePixels = false,
      premultipliedMorph = false,
      morphColour = [0.3, 0.2, 0.35],
      morphKind = 0,
      inkRoot = [0, 0, 0, 0],
    } = {},
  ) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !raw);
    if (image.pixels)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        image.width,
        image.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image.pixels,
      );
    else
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image,
      );
    if (mipmaps) filterColour(gl, image);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    const indices = [],
      uv = [],
      rest = [];
    for (let y = 0; y <= rows; y++)
      for (let x = 0; x <= columns; x++) {
        uv.push(x / columns, y / rows);
        rest.push(
          rect[0] + (rect[2] * x) / columns,
          rect[1] + (rect[3] * y) / rows,
        );
      }
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < columns; x++) {
        const i = y * (columns + 1) + x;
        indices.push(
          i,
          i + 1,
          i + columns + 1,
          i + 1,
          i + columns + 2,
          i + columns + 1,
        );
      }
    const sprite = {
      name,
      zone,
      rect,
      columns,
      rows,
      texture,
      mipmaps,
      nativeCoverage,
      nativePixels,
      premultipliedMorph,
      morphColour,
      morphKind,
      inkRoot,
      opacity: 1,
      rest: new Float32Array(rest),
      positions: new Float32Array(rest),
      uv: new Float32Array(uv),
      indices: new Uint16Array(indices),
      vertexBuffer: gl.createBuffer(),
      uvBuffer: gl.createBuffer(),
      indexBuffer: gl.createBuffer(),
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, sprite.uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, sprite.uv, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sprite.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sprite.indices, gl.STATIC_DRAW);
    const readCanvas = document.createElement("canvas");
    readCanvas.width = image.width;
    readCanvas.height = image.height;
    const ctx = readCanvas.getContext("2d", { willReadFrequently: true });
    if (image.pixels) sprite.alpha = image.pixels;
    else {
      ctx.drawImage(image, 0, 0);
      sprite.alpha = ctx.getImageData(0, 0, image.width, image.height).data;
    }
    sprite.imageWidth = image.width;
    sprite.imageHeight = image.height;
    this.resources.push(sprite);
    return sprite;
  }
  attachRound(sprite, colour, distance, rawDistance = false) {
    const paint = { ...sprite },
      field = { ...sprite };
    this.attachSide(paint, colour, true);
    this.attachSide(field, distance, rawDistance);
    sprite.roundTexture = paint.sideTexture;
    sprite.roundDistance = field.sideTexture;
    if (rawDistance) {
      sprite.materialFlowPixels = distance.pixels;
      sprite.materialFlowWidth = distance.width;
      sprite.materialFlowHeight = distance.height;
      sprite.roundDistancePixels = distance.pixels;
      sprite.roundDistanceWidth = distance.width;
      sprite.roundDistanceHeight = distance.height;
    }
  }
  attachPoseKeys(sprite, frames, invert = false) {
    if (
      !["signed-xy16-dual", "polar-cloth-v1", "axial-cloth-v1", "shared-garment-v1"].includes(
        frames[0].flowEncoding,
      )
    )
      throw new Error("Unsupported arm registration encoding");
    const gl = this.gl;
    this.poseTextureCache ||= new WeakMap();
    this.poseTextures ||= new Set();
    const pixels = (image) => {
      if (image.pixels) return image.pixels;
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, image.width, image.height).data;
    };
    const upload = (image, existing) => {
      if (this.poseTextureCache.has(image))
        return this.poseTextureCache.get(image);
      const texture = existing || gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      if (!existing) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        if (image.pixels)
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            image.width,
            image.height,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            image.pixels,
          );
        else
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            image,
          );
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      }
      this.poseTextureCache.set(image, texture);
      this.poseTextures.add(texture);
      return texture;
    };
    const observations = frames.map((frame, index) => ({
      ...frame,
      texture: upload(frame.image, index === 0 ? sprite.texture : null),
      paintTexture: upload(frame.paint),
      distanceTexture: upload(frame.distance),
      distancePixels: pixels(frame.distance),
      flowTexture: frame.flow ? upload(frame.flow) : null,
      maskTexture: frame.mask ? upload(frame.mask) : null,
    }));
    sprite.poseKeyFrames = observations;
    sprite.poseKey = true;
    sprite.nativeCoverage = true;
    sprite.premultipliedMorph = true;
    sprite.morphKind = 5;
    sprite.layerMaskInvert = invert;
    sprite.poseSpace = true;
    this.selectPoseKey(sprite, 0);
  }
  selectPoseKey(sprite, pose) {
    if (!sprite.poseKeyFrames) return;
    const [index, amount] = poseInterval(sprite.poseKeyFrames, pose),
      a = sprite.poseKeyFrames[index],
      b = sprite.poseKeyFrames[index + 1];
    if (sprite.poseKeyIndex !== index) {
      sprite.poseKeyIndex = index;
      sprite.texture = a.texture;
      sprite.second = b.texture;
      sprite.distanceA = a.distanceTexture;
      sprite.distanceB = b.distanceTexture;
      sprite.distancePixelsA = a.distancePixels;
      sprite.distancePixelsB = b.distancePixels;
      sprite.distanceWidth = a.distance.width;
      sprite.distanceHeight = a.distance.height;
      sprite.roundTexture = a.paintTexture;
      sprite.posePaintB = b.paintTexture;
      sprite.roundDistance = a.flowTexture;
      sprite.materialFlowScale = a.flowScale || 0;
      sprite.materialFlowPixels = a.flow?.pixels;
      sprite.materialFlowWidth = a.flow?.width || 1;
      sprite.materialFlowHeight = a.flow?.height || 1;
      sprite.layerMask = a.maskTexture;
      sprite.layerMaskPixels = a.mask?.pixels;
      sprite.layerMaskWidth = a.mask?.width;
      sprite.layerMaskHeight = a.mask?.height;
      sprite.layerMaskMode = a.mask ? (sprite.layerMaskInvert ? 2 : 1) : 0;
      sprite.layerMaskMorph = Boolean(a.mask);
      sprite.pixelAlignedSampling = undefined;
    }
    sprite.mix = amount;
    if (sprite.materialChart) {
      if (sprite.materialChart.kind === "registered-garment") {
        sprite.registeredGarment = true;
        sprite.cuffCurrent = cuffChartParameters(sprite.materialChart, pose);
      } else if (sprite.materialChart.kind === "garment") {
        sprite.garmentCurrent = garmentFrame(sprite.materialChart, pose);
        sprite.garmentFirst = garmentFrame(sprite.materialChart, a.pose);
        sprite.garmentSecond = garmentFrame(sprite.materialChart, b.pose);
        sprite.cuffCurrent = cuffChartParameters(sprite.materialChart, pose);
      } else if (sprite.materialChart.kind === "cuff") {
        sprite.cuffCurrent = cuffChartParameters(sprite.materialChart, pose);
        sprite.cuffFirst = cuffChartParameters(sprite.materialChart, a.pose);
        sprite.cuffSecond = cuffChartParameters(sprite.materialChart, b.pose);
      } else {
        sprite.clothCurrent = clothChartParameters(sprite.materialChart, pose);
        sprite.clothFirst = clothChartParameters(sprite.materialChart, a.pose);
        sprite.clothSecond = clothChartParameters(sprite.materialChart, b.pose);
      }
    }
  }
  attachMask(sprite, image, invert = false) {
    const gl = this.gl,
      texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      image.width,
      image.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      image.pixels,
    );
    sprite.layerMask = texture;
    sprite.layerMaskPixels = image.pixels;
    sprite.layerMaskWidth = image.width;
    sprite.layerMaskHeight = image.height;
    sprite.layerMaskInvert = invert;
    gl.activeTexture(gl.TEXTURE0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  }
  attachSide(sprite, image, raw = false) {
    const gl = this.gl,
      texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !raw);
    if (image.pixels)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        image.width,
        image.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image.pixels,
      );
    else if (image.pixels)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        image.width,
        image.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image.pixels,
      );
    else
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image,
      );
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    if (sprite.mipmaps) filterColour(gl, image);
    sprite.sideTexture = texture;
    const canvas = document.createElement("canvas");
    canvas.width = sprite.imageWidth;
    canvas.height = sprite.imageHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (image.pixels) {
      sprite.sideAlpha = new Uint8Array(
        sprite.imageWidth * sprite.imageHeight * 4,
      );
      for (let y = 0; y < sprite.imageHeight; y++)
        for (let x = 0; x < sprite.imageWidth; x++) {
          const sx = Math.min(
              image.width - 1,
              Math.floor(((x + 0.5) * image.width) / sprite.imageWidth),
            ),
            sy = Math.min(
              image.height - 1,
              Math.floor(((y + 0.5) * image.height) / sprite.imageHeight),
            );
          sprite.sideAlpha[(y * sprite.imageWidth + x) * 4 + 3] =
            image.pixels[(sy * image.width + sx) * 4 + 3];
        }
    } else {
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      sprite.sideAlpha = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
    }
  }
  attachMorph(sprite, second, distanceA, distanceB) {
    const gl = this.gl;
    const upload = (image, raw = false) => {
      const texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !raw);
      if (image.pixels)
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          image.width,
          image.height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          image.pixels,
        );
      else
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          image,
        );
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      if (raw && sprite.mipmaps) filterColour(gl, image);
      return texture;
    };
    const pixels = (image) => {
      if (image.pixels) return image.pixels;
      const c = document.createElement("canvas");
      c.width = image.width;
      c.height = image.height;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height).data;
    };
    sprite.second = upload(second, true);
    sprite.distanceA = upload(distanceA);
    sprite.distanceB = upload(distanceB);
    sprite.distancePixelsA = pixels(distanceA);
    sprite.distancePixelsB = pixels(distanceB);
    sprite.distanceWidth = distanceA.width;
    sprite.distanceHeight = distanceA.height;
    sprite.mix = 0;
  }
  begin(width, height) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.uniform2f(this.resolution, width, height);
    gl.clearColor(...(this.clearColour || [0, 0, 0, 0]));
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawCalls = 0;
    this.pixelRatio = this.canvas.width / width;
  }
  draw(sprite, transform) {
    if (sprite.opacity < 0.001) return;
    const gl = this.gl;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    // A stationary mesh can still have a moving material chart in its shader.
    // Only the original rest observation uses exact nearest-pixel sampling.
    let pixelAligned =
        Boolean(sprite.nativePixels) &&
        (!sprite.poseKey ||
          (sprite.poseKeyIndex === 0 && sprite.mix < 0.00001)),
      shiftX,
      shiftY;
    for (let i = 0; i < sprite.rest.length; i += 2) {
      const p = transform(
        sprite.rest[i],
        sprite.rest[i + 1],
        sprite.uv[i],
        sprite.uv[i + 1],
      );
      sprite.positions[i] = p[0];
      sprite.positions[i + 1] = p[1];
      if (pixelAligned) {
        const dx = p[0] * this.pixelRatio - sprite.rest[i],
          dy = p[1] * this.pixelRatio - sprite.rest[i + 1];
        if (i === 0) {
          shiftX = Math.round(dx);
          shiftY = Math.round(dy);
        }
        if (Math.abs(dx - shiftX) > 0.0001 || Math.abs(dy - shiftY) > 0.0001)
          pixelAligned = false;
      }
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }
    sprite.bounds = [minX, minY, maxX, maxY];
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sprite.texture);
    if (sprite.nativePixels && sprite.pixelAlignedSampling !== pixelAligned) {
      const filter = pixelAligned ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      // Native visibility is also a texture endpoint. Sampling the complete
      // leg with NEAREST but its native endpoint with LINEAR changed hundreds
      // of antialiased outline pixels even at an exact untransformed pose.
      if (sprite.sideTexture && !sprite.second) {
        gl.bindTexture(gl.TEXTURE_2D, sprite.sideTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.bindTexture(gl.TEXTURE_2D, sprite.texture);
      }
      sprite.pixelAlignedSampling = pixelAligned;
    }
    for (const [unit, texture] of [
      [1, sprite.second || sprite.sideTexture],
      [2, sprite.distanceA],
      [3, sprite.distanceB],
      [4, sprite.posePaintB || sprite.texture],
      [5, sprite.layerMask],
      [6, sprite.roundTexture],
      [7, sprite.roundDistance],
    ]) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture || sprite.texture);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1f(this.mix, sprite.mix || 0);
    gl.uniform1f(this.morph, sprite.second ? 1 : 0);
    gl.uniform1f(this.nativeCoverage, sprite.nativeCoverage ? 1 : 0);
    gl.uniform1f(this.premultipliedMorph, sprite.premultipliedMorph ? 1 : 0);
    gl.uniform3fv(this.morphColour, sprite.morphColour);
    gl.uniform1f(this.morphKind, sprite.morphKind);
    gl.uniform1f(this.materialFlowScale, sprite.materialFlowScale || 0);
    gl.uniform1f(this.surfaceReveal, sprite.surfaceReveal ?? 1);
    gl.uniform1f(this.poseKey, sprite.poseKey ? 1 : 0);
    gl.uniform1f(this.clothUniforms.Chart, sprite.clothCurrent ? 1 : 0);
    gl.uniform1f(this.cuffUniforms.Chart, sprite.cuffCurrent && !sprite.registeredGarment ? 1 : 0);
    gl.uniform4fv(this.handDepth, sprite.handDepth || [0, 0, 0, 0]);
    gl.uniform1f(this.forearmUniforms.Clip, sprite.forearmMouth ? 1 : 0);
    if (sprite.forearmMouth) {
      const { frame, cuff, exit } = sprite.forearmMouth;
      gl.uniformMatrix3fv(
        this.cuffUniforms.Inverse,
        false,
        cuffMatrix(cuff, true),
      );
      gl.uniform4f(
        this.forearmUniforms.Bone,
        ...frame.origin,
        frame.angle,
        frame.length,
      );
      gl.uniform1f(this.forearmUniforms.Width, frame.width);
      gl.uniform1f(this.forearmUniforms.Exit, exit);
    }
    if (sprite.cuffCurrent && !sprite.registeredGarment) {
      const current = sprite.garmentCurrent || sprite.cuffCurrent,
        first = sprite.garmentFirst || sprite.cuffFirst,
        second = sprite.garmentSecond || sprite.cuffSecond;
      gl.uniform4fv(this.clothUniforms.Rect, sprite.rect);
      gl.uniform1f(this.clothUniforms.Mirror, sprite.materialChart.mirror || 0);
      gl.uniformMatrix3fv(
        this.cuffUniforms.Inverse,
        false,
        cuffMatrix(current, true),
      );
      gl.uniformMatrix3fv(
        this.cuffUniforms.First,
        false,
        cuffMatrix(first),
      );
      gl.uniformMatrix3fv(
        this.cuffUniforms.Second,
        false,
        cuffMatrix(second),
      );
    }
    if (sprite.clothCurrent) {
      const frame = sprite.clothCurrent;
      gl.uniform4f(
        this.clothUniforms.Frame,
        ...frame.elbow,
        frame.radius,
        frame.far,
      );
      gl.uniform4fv(this.clothUniforms.Rect, sprite.rect);
      gl.uniform1f(this.clothUniforms.Mirror, sprite.materialChart.mirror || 0);
      for (const [name, value] of [
        ["Current", frame],
        ["First", sprite.clothFirst],
        ["Second", sprite.clothSecond],
      ])
        gl.uniform3f(
          this.clothUniforms[name],
          value.angle,
          value.delta,
          value.sourceAngle,
        );
    }
    gl.uniform1f(
      this.frontPass,
      sprite.frontDepth ? (sprite.frontDepth.back ? 2 : 1) : 0,
    );
    if (sprite.frontDepth) {
      gl.uniform4fv(this.frontDepth, sprite.frontDepth.axis);
      gl.uniform1f(this.frontCut, sprite.frontDepth.cut);
    }
    gl.uniform2f(
      this.poseFlowCellSize,
      sprite.poseKey ? sprite.materialFlowWidth / 6 : 1,
      sprite.poseKey ? sprite.materialFlowHeight / 3 : 1,
    );
    gl.uniform1f(this.layerMaskMorph, sprite.layerMaskMorph ? 1 : 0);
    gl.uniform1f(this.materialCategory, sprite.materialCategory ?? -1);
    gl.uniform4fv(this.inkRoot, sprite.inkRoot);
    gl.uniform1f(
      this.layerMaskMode,
      sprite.layerMask ? (sprite.layerMaskInvert ? 2 : 1) : 0,
    );
    gl.uniform1f(
      this.roundMouth,
      sprite.roundTexture ? sprite.roundMix || 0 : 0,
    );
    gl.uniform1f(this.dualColour, sprite.sideTexture ? 1 : 0);
    gl.uniform1f(this.contourBias, sprite.contourBias || 0);
    gl.uniform1f(
      this.contourAA,
      Math.max(
        0.7,
        (0.5 *
          Math.max(
            sprite.imageWidth / Math.max(1, maxX - minX),
            sprite.imageHeight / Math.max(1, maxY - minY),
          )) /
          this.pixelRatio,
      ),
    );
    gl.uniform1f(this.eyeClosure, sprite.eyeClosure || 0);
    gl.uniform1f(this.clipFrom, sprite.clipFrom || 0);
    gl.uniform1f(this.eyeSurface, sprite.eyeSurface || 0);
    gl.uniform1f(this.eyeLift, sprite.eyeLift || 0);
    gl.uniform1f(this.aperture, sprite.aperture ? 1 : 0);
    gl.uniform1f(this.maskProfile, sprite.aperture?.profile ? 1 : 0);
    if (sprite.aperture) {
      const mask = sprite.aperture;
      if (mask.profile) {
        const p = mask.profile;
        let entry = this.profileTextures.get(p.id);
        gl.uniform1f(this.profileSize, p.width);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.activeTexture(gl.TEXTURE4);
        if (!entry) {
          entry = { texture: gl.createTexture(), width: p.width };
          this.profileTextures.set(p.id, entry);
          gl.bindTexture(gl.TEXTURE_2D, entry.texture);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            p.width,
            1,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            p.data,
          );
        } else {
          gl.bindTexture(gl.TEXTURE_2D, entry.texture);
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0,
            0,
            p.width,
            1,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            p.data,
          );
        }
        gl.activeTexture(gl.TEXTURE0);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      }
      gl.uniform2fv(this.maskOrigin, mask.origin);
      gl.uniform2fv(this.maskU, mask.u);
      gl.uniform2fv(this.maskV, mask.v);
      gl.uniform4fv(this.maskCurve, mask.curve);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, sprite.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, sprite.positions, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.position);
    gl.vertexAttribPointer(this.position, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, sprite.uvBuffer);
    gl.enableVertexAttribArray(this.uv);
    gl.vertexAttribPointer(this.uv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sprite.indexBuffer);
    gl.uniform1f(this.opacity, sprite.opacity);
    gl.drawElements(gl.TRIANGLES, sprite.indices.length, gl.UNSIGNED_SHORT, 0);
    this.drawCalls++;
  }
  hit(sprite, x, y) {
    return Boolean(this.hitUV(sprite, x, y));
  }
  hitUV(sprite, x, y) {
    if (!sprite.zone || sprite.opacity < 0.1) return false;
    if (sprite.frontDepth) {
      const { axis, cut, back } = sprite.frontDepth;
      const depth = (x - axis[0]) * axis[2] + (y - axis[1]) * axis[3];
      if (back ? depth > cut + 0.45 : depth < cut - 0.45) return false;
    }
    if (
      !sprite.bounds ||
      x < sprite.bounds[0] ||
      y < sprite.bounds[1] ||
      x > sprite.bounds[2] ||
      y > sprite.bounds[3]
    )
      return false;
    const p = sprite.positions,
      uv = sprite.uv;
    for (let i = 0; i < sprite.indices.length; i += 3) {
      const a = sprite.indices[i] * 2,
        b = sprite.indices[i + 1] * 2,
        c = sprite.indices[i + 2] * 2;
      const weights = barycentric(
        x,
        y,
        p[a],
        p[a + 1],
        p[b],
        p[b + 1],
        p[c],
        p[c + 1],
      );
      if (!weights) continue;
      const u = uv[a] * weights[0] + uv[b] * weights[1] + uv[c] * weights[2],
        v =
          uv[a + 1] * weights[0] +
          uv[b + 1] * weights[1] +
          uv[c + 1] * weights[2];
      const ix = Math.min(
          sprite.imageWidth - 1,
          Math.max(0, Math.floor(u * sprite.imageWidth)),
        ),
        iy = Math.min(
          sprite.imageHeight - 1,
          Math.max(0, Math.floor(v * sprite.imageHeight)),
        );
      const pixel = (iy * sprite.imageWidth + ix) * 4;
      const [firstUV, secondUV] = materialCoordinates(sprite, u, v);
      if (sprite.clipFrom && v < sprite.clipFrom - 0.015) continue;
      if (sprite.handDepth) {
        const p = sprite.handDepth,
          front = p[0] + p[1] * u + p[2] * v >= 0;
        if (p[3] > 0.5 && (p[3] > 1.5 ? front : !front)) continue;
      }
      if (forearmMouthCoverage(sprite, u, v) < 0.05) continue;
      if (sprite.layerMaskPixels) {
        const maskIndex = (p) =>
            (Math.max(
              0,
              Math.min(
                sprite.layerMaskHeight - 1,
                Math.floor(p[1] * sprite.layerMaskHeight),
              ),
            ) *
              sprite.layerMaskWidth +
              Math.max(
                0,
                Math.min(
                  sprite.layerMaskWidth - 1,
                  Math.floor(p[0] * sprite.layerMaskWidth),
                ),
              )) *
            4,
          amount = sprite.layerMaskMorph ? sprite.mix : 0;
        let coverage =
          ((1 - amount) * sprite.layerMaskPixels[maskIndex(firstUV)] +
            amount * sprite.layerMaskPixels[maskIndex(secondUV) + 1]) /
          255;
        coverage = coverage >= 0.5 ? 1 : 0;
        if (sprite.materialCategory !== undefined) {
          const cuff = ((1-amount)*sprite.layerMaskPixels[maskIndex(firstUV)+2]+
            amount*sprite.layerMaskPixels[maskIndex(secondUV)+3])/255 >= .5;
          coverage = sprite.materialCategory === 0 ? Number(!cuff) :
            sprite.materialCategory === 1 ? Number(cuff && !coverage) : Number(cuff && coverage);
        } else if (sprite.layerMaskInvert) coverage = 1 - coverage;
        if (coverage < 0.2) continue;
      }
      const distanceSample = (data, channel) =>
          sampleChannel(
            data,
            sprite.distanceWidth,
            sprite.distanceHeight,
            ...(data === sprite.distancePixelsA ? firstUV : secondUV),
            channel,
          ),
        decode = (data) =>
          (distanceSample(data, 0) * 256 + distanceSample(data, 1) - 32768) /
          32;
      let alpha = sprite.second
        ? (1 - sprite.mix) * decode(sprite.distancePixelsA) +
            sprite.mix * decode(sprite.distancePixelsB) +
            (sprite.contourBias || 0) >
          -0.5
        : ((1 - (sprite.sideAlpha ? sprite.mix || 0 : 0)) *
            sprite.alpha[pixel + 3] +
            (sprite.sideAlpha
              ? (sprite.mix || 0) * sprite.sideAlpha[pixel + 3]
              : 0)) *
            sprite.opacity >
          45;
      if (
        sprite.second &&
        sprite.nativeHandVisibility &&
        (sprite.surfaceReveal ?? 1) < 0.99999
      ) {
        const sample = (channel) =>
          sampleChannel(
            sprite.roundDistancePixels,
            sprite.roundDistanceWidth,
            sprite.roundDistanceHeight,
            u,
            v,
            channel,
          );
        const nativeDistance = (sample(0) * 256 + sample(1) - 32768) / 32;
        const physical =
          (1 - sprite.mix) * decode(sprite.distancePixelsA) +
          sprite.mix * decode(sprite.distancePixelsB);
        const distance =
          nativeDistance * (1 - sprite.surfaceReveal) +
          physical * sprite.surfaceReveal +
          (sprite.contourBias || 0);
        alpha = smoothstep(-0.7, 0.7, distance) * sprite.opacity > 45 / 255;
      } else if (sprite.second && sprite.nativeCoverage) {
        const m = sprite.mix || 0,
          d =
            (1 - m) * decode(sprite.distancePixelsA) +
            m * decode(sprite.distancePixelsB) +
            (sprite.contourBias || 0),
          native =
            distanceSample(
              m < 0.5 ? sprite.distancePixelsA : sprite.distancePixelsB,
              2,
            ) / 255,
          transition = smoothstep(0, 0.12, Math.min(m, 1 - m)),
          coverage =
            native * (1 - transition) + smoothstep(-0.7, 0.7, d) * transition;
        alpha = coverage * sprite.opacity > 45 / 255;
      }
      if (alpha) return [u, v];
    }
    return false;
  }
  dispose() {
    for (const texture of this.poseTextures || [])
      this.gl.deleteTexture(texture);
    this.poseTextures?.clear();
    for (const entry of this.profileTextures.values())
      this.gl.deleteTexture(entry.texture);
    this.profileTextures.clear();
    for (const s of this.resources) {
      this.gl.deleteTexture(s.texture);
      if (s.second) this.gl.deleteTexture(s.second);
      if (s.sideTexture) this.gl.deleteTexture(s.sideTexture);
      if (s.distanceA) this.gl.deleteTexture(s.distanceA);
      if (s.distanceB) this.gl.deleteTexture(s.distanceB);
      if (s.layerMask) this.gl.deleteTexture(s.layerMask);
      if (s.roundTexture) this.gl.deleteTexture(s.roundTexture);
      if (s.roundDistance) this.gl.deleteTexture(s.roundDistance);
      this.gl.deleteBuffer(s.vertexBuffer);
      this.gl.deleteBuffer(s.uvBuffer);
      this.gl.deleteBuffer(s.indexBuffer);
    }
    this.gl.deleteProgram(this.program);
    this.resources = [];
  }
}
