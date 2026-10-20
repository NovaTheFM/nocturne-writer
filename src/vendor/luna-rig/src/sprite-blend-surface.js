const vertexSource = `attribute vec2 a_position;
void main(){gl_Position=vec4(a_position,0.0,1.0);}`;
const fragmentSource = `precision highp float;
uniform sampler2D u_previous;
uniform sampler2D u_current;
uniform sampler2D u_reference;
uniform vec2 u_size;
uniform float u_progress;
uniform float u_mask;
uniform vec4 u_region;
uniform vec4 u_exclude;
uniform float u_feather;
float boxMask(vec2 p,vec4 r){
  vec2 edge=min(p-r.xy,r.xy+r.zw-p);
  return smoothstep(0.0,max(u_feather,0.001),min(edge.x,edge.y));
}
void main(){
  vec2 uv=gl_FragCoord.xy/u_size;
  vec4 current=texture2D(u_current,uv);
  vec4 previous=texture2D(u_previous,uv);
  vec4 delta=abs(previous-texture2D(u_reference,uv));
  // Restrict the dissolve to artwork that actually changed with the pose.
  // Unchanged hair, dress and body keep their live animation, not an old still.
  float changed=step(1.5/255.0,max(max(delta.r,delta.g),max(delta.b,delta.a)));
  vec2 pixel=vec2(gl_FragCoord.x,u_size.y-gl_FragCoord.y);
  float mask=u_mask>0.5?boxMask(pixel,u_region)*(1.0-boxMask(pixel,u_exclude)):1.0;
  // Match transitionLunaImage: the ready target stays at full opacity;
  // only the old front image fades. Both samples are premultiplied RGBA.
  float oldWeight=1.0-u_progress;
  vec4 layered=previous*oldWeight+current*(1.0-previous.a*oldWeight);
  gl_FragColor=mix(current,layered,mask*changed);
}`;

function shader(gl, kind, source) {
  const result = gl.createShader(kind);
  gl.shaderSource(result, source);
  gl.compileShader(result);
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(result);
    gl.deleteShader(result);
    throw new Error(message);
  }
  return result;
}

/** A framebuffer copy and a single premultiplied blend, in the rig's context. */
export class SpriteBlendSurface {
  constructor(
    canvas,
    { gl = canvas.getContext("webgl"), reservedAttributes = [] } = {},
  ) {
    if (!gl) throw new Error("WebGL недоступен для перехода поз.");
    this.canvas = canvas;
    this.gl = gl;
    this.attribute = Array.from(
      { length: gl.getParameter(gl.MAX_VERTEX_ATTRIBS) },
      (_, i) => i,
    ).find((i) => !reservedAttributes.includes(i));
    if (this.attribute === undefined)
      throw new Error("Нет свободного атрибута для перехода поз.");
    const vs = shader(gl, gl.VERTEX_SHADER, vertexSource);
    const fs = shader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.bindAttribLocation(this.program, this.attribute, "a_position");
    gl.linkProgram(this.program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(this.program));
    this.uniforms = Object.fromEntries(
      [
        "previous",
        "reference",
        "current",
        "size",
        "progress",
        "mask",
        "region",
        "exclude",
        "feather",
      ].map((name) => [name, gl.getUniformLocation(this.program, "u_" + name)]),
    );
    this.previous = { texture: gl.createTexture(), width: 0, height: 0 };
    this.current = { texture: gl.createTexture(), width: 0, height: 0 };
    this.reference = { texture: gl.createTexture(), width: 0, height: 0 };
    this.vertices = gl.createBuffer();
    this.withState(() => {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW,
      );
      gl.activeTexture(gl.TEXTURE0);
      for (const entry of [this.previous, this.current, this.reference]) {
        gl.bindTexture(gl.TEXTURE_2D, entry.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
    });
  }

  withState(fn) {
    const gl = this.gl;
    const program = gl.getParameter(gl.CURRENT_PROGRAM);
    const array = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    const active = gl.getParameter(gl.ACTIVE_TEXTURE);
    const attributeEnabled = gl.getVertexAttrib(
      this.attribute,
      gl.VERTEX_ATTRIB_ARRAY_ENABLED,
    );
    const caps = [
      gl.BLEND,
      gl.DEPTH_TEST,
      gl.SCISSOR_TEST,
      gl.CULL_FACE,
      gl.DITHER,
    ].map((cap) => [cap, gl.isEnabled(cap)]);
    const textures = [0, 1, 2].map((unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      return gl.getParameter(gl.TEXTURE_BINDING_2D);
    });
    try {
      return fn();
    } finally {
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, array);
      if (attributeEnabled) gl.enableVertexAttribArray(this.attribute);
      else gl.disableVertexAttribArray(this.attribute);
      for (let unit = 0; unit < textures.length; unit++) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, textures[unit]);
      }
      gl.activeTexture(active);
      for (const [cap, enabled] of caps) {
        if (enabled) gl.enable(cap);
        else gl.disable(cap);
      }
    }
  }

  capture(entry) {
    const gl = this.gl,
      { width, height } = this.canvas;
    this.withState(() => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      if (entry.width !== width || entry.height !== height) {
        gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, width, height, 0);
        entry.width = width;
        entry.height = height;
      } else gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
    });
  }

  capturePrevious() {
    this.capture(this.previous);
  }
  captureCurrent() {
    this.capture(this.current);
  }
  captureReference() {
    this.capture(this.reference);
  }

  draw(progress, region) {
    if (!this.previous.width || !this.current.width) return;
    const gl = this.gl,
      u = this.uniforms;
    this.withState(() => {
      for (const cap of [
        gl.BLEND,
        gl.DEPTH_TEST,
        gl.SCISSOR_TEST,
        gl.CULL_FACE,
        gl.DITHER,
      ])
        gl.disable(cap);
      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices);
      gl.enableVertexAttribArray(this.attribute);
      gl.vertexAttribPointer(this.attribute, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.previous.texture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.current.texture);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.reference.texture);
      gl.uniform1i(u.previous, 0);
      gl.uniform1i(u.current, 1);
      gl.uniform1i(u.reference, 2);
      gl.uniform2f(u.size, this.canvas.width, this.canvas.height);
      gl.uniform1f(u.progress, progress);
      gl.uniform1f(u.mask, region ? 1 : 0);
      gl.uniform4fv(u.region, region?.rect || [0, 0, 0, 0]);
      gl.uniform4fv(u.exclude, region?.exclude || [0, 0, 0, 0]);
      gl.uniform1f(u.feather, region?.feather || 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    });
  }

  destroy() {
    const gl = this.gl;
    gl.deleteTexture(this.previous.texture);
    gl.deleteTexture(this.current.texture);
    gl.deleteTexture(this.reference.texture);
    gl.deleteBuffer(this.vertices);
    gl.deleteProgram(this.program);
  }
}
