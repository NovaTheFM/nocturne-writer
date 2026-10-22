import { StateSpriteTransition } from '../vendor/luna-rig/src/state-sprite-transition.js';
import { SpriteBlendSurface } from '../vendor/luna-rig/src/sprite-blend-surface.js';

export const LUNA_POSE_MOTION = Object.freeze({ duration: 380, easing: 'cubic-bezier(.4, 0, .2, 1)' });

class LunaPoseSurface extends SpriteBlendSurface {
  constructor(canvas, graphics) {
    super(canvas, graphics);
    const gl = this.gl, previous = this.program;
    const compile = (kind, source) => {
      const shader = gl.createShader(kind);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(message);
      }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, 'attribute vec2 a_position; void main(){gl_Position=vec4(a_position,0.0,1.0);}');
    const fragment = compile(gl.FRAGMENT_SHADER, `precision highp float;
      uniform sampler2D u_previous, u_current;
      uniform vec2 u_size;
      uniform float u_progress;
      void main(){
        vec2 uv=gl_FragCoord.xy/u_size;
        gl_FragColor=mix(texture2D(u_previous,uv),texture2D(u_current,uv),u_progress);
      }`);
    this.program = gl.createProgram();
    gl.attachShader(this.program, vertex); gl.attachShader(this.program, fragment);
    gl.bindAttribLocation(this.program, this.attribute, 'a_position'); gl.linkProgram(this.program);
    gl.deleteShader(vertex); gl.deleteShader(fragment); gl.deleteProgram(previous);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
    this.uniforms = Object.fromEntries(Object.keys(this.uniforms).map(name => [name, gl.getUniformLocation(this.program, `u_${name}`)]));
  }
}

export class LunaPoseTransition extends StateSpriteTransition {
  constructor(canvas, graphics) {
    super(canvas, { ...graphics, surface: new LunaPoseSurface(canvas, graphics) });
  }

  begin(request) {
    super.begin(request);
    this.animation?.effect.updateTiming(LUNA_POSE_MOTION);
  }
}
