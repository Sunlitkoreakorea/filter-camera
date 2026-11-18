// WebGL 필터 렌더러: 원본 텍스처 -> 3D LUT -> 비네팅/입자 -> 세기 섞기
import { FILTERS, N, buildLutAtlas } from './filters.js?v=1';

let atlasCache = null;
const atlas = () => (atlasCache ||= buildLutAtlas());

const VS = `
attribute vec2 aPos;
uniform vec4 uSrc;      // 원본에서 잘라 쓸 영역 (x, y, w, h), 0~1, y는 아래로
uniform float uMirror;
varying vec2 vOut;
varying vec2 vSrc;
void main() {
  vec2 t = aPos * 0.5 + 0.5;
  vOut = vec2(t.x, 1.0 - t.y);
  vec2 u = vOut;
  if (uMirror > 0.5) u.x = 1.0 - u.x;
  vSrc = uSrc.xy + u * uSrc.zw;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vOut;
varying vec2 vSrc;
uniform sampler2D uImg;
uniform sampler2D uLut;
uniform float uRow;
uniform float uRows;
uniform float uAmount;
uniform float uVig;
uniform float uGrain;
uniform float uSeed;
uniform vec2 uFrame;    // 짧은 변 = 1 로 맞춘 화면 비율
const float N = ${N.toFixed(1)};

vec3 lut(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  float b = c.b * (N - 1.0);
  float b0 = floor(b);
  float b1 = min(b0 + 1.0, N - 1.0);
  float f = b - b0;
  vec2 rg = c.rg * (N - 1.0) + 0.5;
  float y = (uRow * N + rg.y) / (N * uRows);
  vec3 c0 = texture2D(uLut, vec2((b0 * N + rg.x) / (N * N), y)).rgb;
  vec3 c1 = texture2D(uLut, vec2((b1 * N + rg.x) / (N * N), y)).rgb;
  return mix(c0, c1, f);
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec3 src = texture2D(uImg, vSrc).rgb;
  vec3 c = lut(src);
  if (uVig > 0.0) {
    float d = length(vOut - 0.5) * 1.41421;
    c *= 1.0 - uVig * smoothstep(0.35, 1.05, d);
  }
  if (uGrain > 0.0) {
    vec2 p = vOut * uFrame * 520.0 + uSeed * vec2(37.0, 91.0);
    float n = vnoise(p) * 0.65 + vnoise(p * 2.13 + 17.0) * 0.35 - 0.5;
    float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float w = 1.0 - pow(abs(L * 2.0 - 1.0), 2.0) * 0.7;
    c += n * uGrain * 0.22 * w;
  }
  gl_FragColor = vec4(clamp(mix(src, c, uAmount), 0.0, 1.0), 1.0);
}`;

export class Renderer {
  constructor(canvas, { preserve = false } = {}) {
    this.canvas = canvas;
    this.preserve = preserve;
    this.ok = false;
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.ok = false; });
    canvas.addEventListener('webglcontextrestored', () => this.init());
    this.init();
  }

  init() {
    const gl = this.canvas.getContext('webgl', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: this.preserve,
    });
    if (!gl) throw new Error('WebGL을 쓸 수 없어요');
    this.gl = gl;

    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.u = {};
    for (const n of ['uSrc', 'uMirror', 'uImg', 'uLut', 'uRow', 'uRows', 'uAmount', 'uVig', 'uGrain', 'uSeed', 'uFrame'])
      this.u[n] = gl.getUniformLocation(prog, n);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const tex = unit => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const a = atlas();
    this.lutTex = tex(1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, a.width, a.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, a.data);
    this.imgTex = tex(0);
    gl.uniform1i(this.u.uImg, 0);
    gl.uniform1i(this.u.uLut, 1);
    gl.uniform1f(this.u.uRows, FILTERS.length);
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.ok = true;
  }

  // video / canvas / ImageBitmap / img 를 원본 텍스처로 올린다
  upload(source) {
    if (!this.ok) return false;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return true;
  }

  resize(w, h) {
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  // vp: 캔버스 안 그릴 위치(px, 왼쪽 위 기준), crop: 원본에서 쓸 영역(0~1)
  draw({ filter = 0, amount = 1, crop = { x: 0, y: 0, w: 1, h: 1 }, mirror = false, seed = 0, vp = null, frame = null }) {
    if (!this.ok) return;
    const gl = this.gl, f = FILTERS[filter].p, u = this.u;
    const W = this.canvas.width, H = this.canvas.height;
    const v = vp || { x: 0, y: 0, w: W, h: H };
    gl.viewport(v.x, H - v.y - v.h, v.w, v.h);
    gl.uniform4f(u.uSrc, crop.x, crop.y, crop.w, crop.h);
    gl.uniform1f(u.uMirror, mirror ? 1 : 0);
    gl.uniform1f(u.uRow, filter);
    gl.uniform1f(u.uAmount, amount);
    gl.uniform1f(u.uVig, f.vignette || 0);
    gl.uniform1f(u.uGrain, f.grain || 0);
    gl.uniform1f(u.uSeed, seed);
    const fw = frame ? frame.w : v.w, fh = frame ? frame.h : v.h, m = Math.min(fw, fh);
    gl.uniform2f(u.uFrame, fw / m, fh / m);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
