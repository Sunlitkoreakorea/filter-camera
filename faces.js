// 얼굴 인식(MediaPipe Face Landmarker, 기기 안에서만 처리)과 얼굴 효과 모양 계산
const VER = '0.10.21';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
export const MAX_FACES = 3;
export const MAXP = 32;           // 셰이더가 받는 효과 원 개수 상한

let lm = null, loading = null, mode = 'VIDEO', switching = null, lastTs = 0;

export const faceReady = () => !!lm;

export function loadFace() {
  return (loading ||= (async () => {
    const v = await import(`${CDN}/vision_bundle.mjs`);
    const files = await v.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
    const opts = delegate => ({ baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: 'VIDEO', numFaces: MAX_FACES });
    try { lm = await v.FaceLandmarker.createFromOptions(files, opts('GPU')); }
    catch { lm = await v.FaceLandmarker.createFromOptions(files, opts('CPU')); }
    mode = 'VIDEO';
    return lm;
  })().catch(e => { loading = null; throw e; }));
}

async function useMode(m) {
  while (switching) await switching;
  if (mode === m) return;
  switching = lm.setOptions({ runningMode: m });
  try { await switching; mode = m; } finally { switching = null; }
}

// 카메라 한 프레임에서 얼굴 점 찾기 (준비 안 됐으면 null)
export function detectVideo(video) {
  if (!lm || switching) return null;
  if (mode !== 'VIDEO') { useMode('VIDEO'); return null; }
  let ts = performance.now();
  if (ts <= lastTs) ts = lastTs + 1;
  lastTs = ts;
  try { return lm.detectForVideo(video, ts).faceLandmarks || []; } catch { return null; }
}

// 사진 한 장에서 얼굴 점 찾기
export async function detectImage(src) {
  await loadFace();
  await useMode('IMAGE');
  try { return lm.detect(src).faceLandmarks || []; }
  finally { useMode('VIDEO'); }
}

// 쓰는 점만 골라 화면 좌표(0~1, 잘라낸 영역과 좌우반전 반영)로
const KEYS = {
  re: 468, le: 473,                       // 두 눈동자
  reo: 33, rei: 133, leo: 263, lei: 362,  // 눈꼬리
  nose: 1, nl: 98, nr: 327,               // 코끝, 콧볼
  ml: 61, mr: 291, mu: 13, md: 14,        // 입꼬리, 윗입술, 아랫입술
  chin: 152, fh: 10, br: 168,             // 턱끝, 이마, 콧등
  cr: 234, cl: 454, chr: 205, chl: 425,   // 얼굴 옆선, 볼
  j1: 172, j2: 136, j3: 150, j4: 149,     // 턱선 한쪽
  k1: 397, k2: 365, k3: 379, k4: 378,     // 턱선 반대쪽
};
export function pickFaces(list, crop = { x: 0, y: 0, w: 1, h: 1 }, mirror = false) {
  return (list || []).slice(0, MAX_FACES).map(lms => {
    const o = {};
    for (const k in KEYS) {
      const p = lms[KEYS[k]];
      if (!p) return null;
      let x = (p.x - crop.x) / crop.w;
      if (mirror) x = 1 - x;
      o[k] = [x, (p.y - crop.y) / crop.h];
    }
    return o;
  }).filter(Boolean);
}

// 프레임 사이 떨림 줄이기
export function smoothFaces(prev, next, a = 0.55) {
  if (!prev || !next || prev.length !== next.length) return next;
  return next.map((f, i) => {
    const o = {};
    for (const k in f) o[k] = [prev[i][k][0] + (f[k][0] - prev[i][k][0]) * a, prev[i][k][1] + (f[k][1] - prev[i][k][1]) * a];
    return o;
  });
}

/* ---------- 효과 모양: 효과 원 = 중심, 반지름, 부풀리기(+)/줄이기(-), 밀기 방향 ---------- */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const len = a => Math.hypot(a[0], a[1]);
const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const P = (c, R, s, v = [0, 0]) => ({ c, R, s, v });

function geo(f) {
  const down = norm(sub(f.chin, f.br));
  return {
    faceW: len(sub(f.cl, f.cr)),
    faceH: len(sub(f.chin, f.fh)),
    eyeW: (len(sub(f.reo, f.rei)) + len(sub(f.leo, f.lei))) / 2,
    noseW: len(sub(f.nl, f.nr)),
    mouthW: len(sub(f.ml, f.mr)),
    mouth: mid(f.mu, f.md),
    down,
    // 얼굴 가운데 선(콧등→턱끝)으로 향하는 방향
    inward: p => { const d = sub(p, f.br), t = d[0] * down[0] + d[1] * down[1]; return norm(sub(add(f.br, mul(down, t)), p)); },
  };
}
const JAW = ['j1', 'j2', 'j3', 'j4', 'k1', 'k2', 'k3', 'k4'];
const slimJaw = (f, g, k) => [
  ...JAW.map(n => P(f[n], g.faceW * 0.26, 0, mul(g.inward(f[n]), 0.085 * g.faceW * k))),
  ...['cr', 'cl'].map(n => P(f[n], g.faceW * 0.24, 0, mul(g.inward(f[n]), 0.05 * g.faceW * k))),
];

const FX = {
  bigeyes: (f, g, k) => [P(f.re, g.eyeW * 1.4, 0.5 * k), P(f.le, g.eyeW * 1.4, 0.5 * k)],
  slim: (f, g, k) => slimJaw(f, g, k),
  alien: (f, g, k) => [
    P(f.re, g.eyeW * 1.7, 0.65 * k), P(f.le, g.eyeW * 1.7, 0.65 * k),
    P(f.chin, g.faceW * 0.42, -0.5 * k), P(g.mouth, g.mouthW * 0.8, -0.45 * k),
    ...slimJaw(f, g, k * 1.2),
  ],
  bignose: (f, g, k) => [P(f.nose, g.noseW * 1.35, 0.55 * k)],
  smallnose: (f, g, k) => [P(f.nose, g.noseW * 1.35, -0.6 * k)],
  cheeks: (f, g, k) => ['chr', 'chl'].map(n => P(f[n], g.faceW * 0.32, 0.5 * k, mul(g.inward(f[n]), -0.04 * g.faceW * k))),
  bigmouth: (f, g, k) => [P(g.mouth, g.mouthW * 0.8, 0.55 * k)],
  longface: (f, g, k) => [P(f.chin, g.faceW * 0.6, 0, mul(g.down, 0.16 * g.faceH * k)), P(f.fh, g.faceW * 0.55, 0, mul(g.down, -0.09 * g.faceH * k))],
};

// 셰이더로 넘길 배열 채우기. a: [중심x, 중심y, 반지름, 부풀리기] (짧은 변 = 1 단위), b: 밀기 방향 (원 2개씩)
export function buildFacePrims(faces, fx, k, fw, fh, a, b) {
  a.fill(0); b.fill(0);
  if (!faces || !FX[fx] || k <= 0) return 0;
  let n = 0;
  for (const raw of faces) {
    const f = {};
    for (const key in raw) f[key] = [raw[key][0] * fw, raw[key][1] * fh];
    for (const p of FX[fx](f, geo(f), k)) {
      if (n >= MAXP) return n;
      a.set([p.c[0], p.c[1], Math.max(p.R, 1e-4), p.s], n * 4);
      b.set(p.v, n * 2);
      n++;
    }
  }
  return n;
}
