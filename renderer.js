// WebGL 렌더러: 좌표 비틀기(왜곡) -> 원본 텍스처 -> 3D LUT(색 필터) -> 비네팅/입자 -> 세기 섞기
import { FILTERS, N, buildLutAtlas } from './filters.js?v=3';

let atlasCache = null;
const atlas = () => (atlasCache ||= buildLutAtlas());

const VS = `
attribute vec2 aPos;
varying vec2 vOut;
void main() {
  vec2 t = aPos * 0.5 + 0.5;
  vOut = vec2(t.x, 1.0 - t.y);   // 화면 좌표 0~1, y는 아래로
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vOut;
uniform sampler2D uImg;
uniform sampler2D uLut;
uniform vec4 uSrc;      // 원본에서 잘라 쓸 영역 (x, y, w, h)
uniform float uMirror;
uniform float uRow;
uniform float uRows;
uniform float uAmount;
uniform float uVig;
uniform float uGrain;
uniform float uSeed;
uniform vec2 uFrame;    // 짧은 변 = 1 로 맞춘 화면 비율
uniform float uWarp;
uniform float uWarpAmt;
uniform vec2 uCenter;
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

vec2 rot(vec2 v, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

// 화면 좌표 o 를 원본에서 읽을 좌표로 바꾼다 (짧은 변 = 1 단위로 계산)
vec2 warp(vec2 o) {
  float w = floor(uWarp + 0.5);
  if (w < 0.5 || uWarpAmt <= 0.0) return o;
  float k = uWarpAmt;
  vec2 q = (o - uCenter) * uFrame;
  float r = length(q);
  if (w < 1.5) {                       // 볼록
    float t = r / 0.55;
    if (t < 1.0) q *= 1.0 - 0.75 * k * (1.0 - t) * (1.0 - t);
  } else if (w < 2.5) {                // 오목
    float t = r / 0.55;
    if (t < 1.0) q *= 1.0 + 1.8 * k * (1.0 - t) * (1.0 - t);
  } else if (w < 3.5) {                // 소용돌이
    float t = r / 0.62;
    if (t < 1.0) q = rot(q, 4.2 * k * (1.0 - t) * (1.0 - t));
  } else if (w < 4.5) {                // 쥐어짜기 (가운데를 좌우로 눌러 홀쭉하게)
    float t = abs(q.x) / 0.62;
    if (t < 1.0) q.x *= 1.0 + 1.6 * k * (1.0 - t) * (1.0 - t);
  } else if (w < 5.5) {                // 늘이기 (가운데를 위아래로 길쭉하게)
    float t = abs(q.y) / 0.62;
    if (t < 1.0) q.y *= 1.0 - 0.7 * k * (1.0 - t) * (1.0 - t);
  } else if (w < 6.5) {                // 거울 (왼쪽을 뒤집어 오른쪽에)
    if (q.x > 0.0) q.x = -q.x;
  } else if (w < 7.5) {                // 빛의 터널
    float R = mix(1.3, 0.22, k);
    if (r > R) q *= R / r;
  } else if (w < 8.5) {                // 어안: 등입체각 투영, 초점거리 30mm(k=0) ~ 8mm(k=1), 35mm 환산
    float f = mix(30.0, 8.0, k);
    float Hd = 0.5 * length(uFrame);              // 화면 반대각 (짧은 변 = 1)
    float mmPer = 21.63 / Hd;                     // 35mm 필름 반대각 21.63mm 에 맞춤
    float R180 = 1.41421 * f / mmPer;             // 화각 180° 원의 반지름
    if (r > R180) return vec2(-1.0);              // 원 밖은 검정
    float Rref = min(R180, Hd);
    float Sref = clamp(Rref, 0.5, Hd);
    float th = 2.0 * asin(min(r * mmPer / (2.0 * f), 1.0));
    float thRef = 2.0 * asin(min(Rref * mmPer / (2.0 * f), 1.0));
    float aS = 0.70;                              // 원본(폰 카메라) 반대각 화각의 절반, 약 40°
    if (r > 0.0) q *= Sref * tan(th * aS / thRef) / tan(aS) / r;
  } else if (w < 9.5) {                // 물결 (중심에서 퍼지는 동심원)
    if (r > 0.0) q += q / r * (0.022 * k * sin(r * 55.0) * exp(-r * 1.3));
  } else if (w < 10.5) {               // 만화경
    float n = floor(mix(3.0, 8.0, k) + 0.5);
    float seg = 6.2831853 / n;
    float a = mod(atan(q.y, q.x) + 1.5707963, seg);
    if (a > seg * 0.5) a = seg - a;
    a -= 1.5707963;
    q = r * vec2(cos(a), sin(a));
  } else if (w < 11.5) {               // 모자이크
    float cell = mix(0.006, 0.045, k);
    q = (floor(q / cell) + 0.5) * cell;
  } else if (w > 13.5 && w < 14.5) {   // 팝아트: 화면을 2×2로 나눠 같은 그림 4장
    return fract(o * 2.0);
  }
  return uCenter + q / uFrame;
}

vec3 srcAt(vec2 u) {
  u = clamp(u, 0.0, 1.0);
  if (uMirror > 0.5) u.x = 1.0 - u.x;
  return texture2D(uImg, uSrc.xy + u * uSrc.zw).rgb;
}
float lumAt(vec2 u) { return dot(srcAt(u), vec3(0.299, 0.587, 0.114)); }
float edgeAt(vec2 u) {
  vec2 d = vec2(0.0018) / uFrame;
  float tl = lumAt(u + vec2(-d.x, -d.y)), tc = lumAt(u + vec2(0.0, -d.y)), tr = lumAt(u + vec2(d.x, -d.y));
  float ml = lumAt(u + vec2(-d.x, 0.0)), mr = lumAt(u + vec2(d.x, 0.0));
  float bl = lumAt(u + vec2(-d.x, d.y)), bc = lumAt(u + vec2(0.0, d.y)), br = lumAt(u + vec2(d.x, d.y));
  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  return length(vec2(gx, gy));
}
vec3 thermal(float t) {
  t = clamp(t, 0.0, 1.0) * 5.0;
  if (t < 1.0) return mix(vec3(0.0, 0.0, 0.1), vec3(0.25, 0.0, 0.65), t);
  if (t < 2.0) return mix(vec3(0.25, 0.0, 0.65), vec3(0.9, 0.0, 0.5), t - 1.0);
  if (t < 3.0) return mix(vec3(0.9, 0.0, 0.5), vec3(1.0, 0.4, 0.0), t - 2.0);
  if (t < 4.0) return mix(vec3(1.0, 0.4, 0.0), vec3(1.0, 0.88, 0.1), t - 3.0);
  return mix(vec3(1.0, 0.88, 0.1), vec3(1.0, 1.0, 0.92), t - 4.0);
}
vec3 pop3(float l, vec3 a, vec3 b, vec3 c) {
  return mix(mix(a, b, smoothstep(0.30, 0.36, l)), c, smoothstep(0.58, 0.64, l));
}

// 색을 새로 칠하는 효과 (열화상, 엑스레이, 팝아트, 만화, 스케치)
vec3 stylize(vec3 s, vec2 u) {
  float w = floor(uWarp + 0.5);
  float L = dot(s, vec3(0.299, 0.587, 0.114));
  if (w < 12.5) return thermal(smoothstep(0.05, 0.95, L));
  if (w < 13.5) {
    float v = pow(1.0 - L, 1.5) * 1.2;
    return vec3(0.68, 0.88, 1.0) * v + vec3(0.01, 0.03, 0.07);
  }
  if (w < 14.5) {
    vec2 qd = floor(clamp(vOut, 0.0, 0.999) * 2.0);
    float i = qd.x + 2.0 * qd.y;
    if (i < 0.5) return pop3(L, vec3(0.1, 0.1, 0.45), vec3(0.95, 0.2, 0.6), vec3(1.0, 0.92, 0.2));
    if (i < 1.5) return pop3(L, vec3(0.55, 0.05, 0.1), vec3(1.0, 0.5, 0.1), vec3(0.45, 0.95, 1.0));
    if (i < 2.5) return pop3(L, vec3(0.3, 0.05, 0.4), vec3(0.55, 0.95, 0.2), vec3(1.0, 0.72, 0.86));
    return pop3(L, vec3(0.0, 0.3, 0.35), vec3(0.95, 0.15, 0.15), vec3(0.62, 0.86, 1.0));
  }
  float e = edgeAt(u);
  if (w < 15.5) {
    vec2 d = vec2(0.0018) / uFrame;
    vec3 sm = (s + srcAt(u + vec2(d.x, 0.0)) + srcAt(u - vec2(d.x, 0.0)) + srcAt(u + vec2(0.0, d.y)) + srcAt(u - vec2(0.0, d.y))) / 5.0;
    vec3 p = floor(clamp(sm, 0.0, 1.0) * 4.0 + 0.5) / 4.0;
    float pl = dot(p, vec3(0.299, 0.587, 0.114));
    p = clamp(pl + (p - pl) * 1.35, 0.0, 1.0);
    return mix(p, vec3(0.04), smoothstep(0.18, 0.38, e));
  }
  float pencil = 1.0 - smoothstep(0.06, 0.42, e) * 0.85;
  float tone = mix(0.62, 1.0, smoothstep(0.08, 0.75, L));
  return vec3(0.97, 0.955, 0.92) * pencil * tone;
}

void main() {
  vec2 u = warp(vOut);
  bool outside = u.x < 0.0 || u.x > 1.0 || u.y < 0.0 || u.y > 1.0;
  vec3 src = srcAt(u);
  float w = floor(uWarp + 0.5);
  if (outside && w > 7.5 && w < 8.5) src = vec3(0.0);
  if (w > 11.5 && uWarpAmt > 0.0) src = mix(src, stylize(src, clamp(u, 0.0, 1.0)), uWarpAmt);
  vec3 c = lut(src);
  if (uVig > 0.0) {
    float d = length(vOut - 0.5) * 1.41421;
    c *= 1.0 - uVig * smoothstep(0.35, 1.05, d);
  }
  if (uGrain > 0.0) {
    vec2 p = vOut * uFrame * 520.0 + uSeed * vec2(37.0, 91.0);
    float n = vnoise(p) * 0.65 + vnoise(p * 2.13 + 17.0) * 0.35 - 0.5;
    float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float wt = 1.0 - pow(abs(L * 2.0 - 1.0), 2.0) * 0.7;
    c += n * uGrain * 0.22 * wt;
  }
  gl_FragColor = vec4(clamp(mix(src, c, uAmount), 0.0, 1.0), 1.0);
}`;

const UNIFORMS = ['uSrc', 'uMirror', 'uImg', 'uLut', 'uRow', 'uRows', 'uAmount', 'uVig', 'uGrain', 'uSeed', 'uFrame', 'uWarp', 'uWarpAmt', 'uCenter'];

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
    for (const n of UNIFORMS) this.u[n] = gl.getUniformLocation(prog, n);

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
    gl.clearColor(0, 0, 0, 1);
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

  clear() {
    if (!this.ok) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // vp: 캔버스 안 그릴 위치(px, 왼쪽 위 기준), crop: 원본에서 쓸 영역(0~1)
  // warp: WARPS 번호, warpAmt: 0~1, center: [x, y] 화면 좌표 0~1
  draw({ filter = 0, amount = 1, crop = { x: 0, y: 0, w: 1, h: 1 }, mirror = false, seed = 0, vp = null,
         warp = 0, warpAmt = 1, center = [0.5, 0.5] }) {
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
    const m = Math.min(v.w, v.h);
    gl.uniform2f(u.uFrame, v.w / m, v.h / m);
    gl.uniform1f(u.uWarp, warp);
    gl.uniform1f(u.uWarpAmt, warpAmt);
    gl.uniform2f(u.uCenter, center[0], center[1]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
