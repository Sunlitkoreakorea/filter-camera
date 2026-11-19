// 필터 정의와 3D LUT 생성
// 필터 하나 = 숫자 몇 개. 고치거나 새로 넣을 땐 FILTERS 배열만 건드리면 된다.
//
//  temp      색온도 (-1 시원 ~ +1 따뜻)
//  tint      색조 (-1 초록 ~ +1 자홍)
//  bright    밝기 (+면 밝게, 양 끝은 유지)
//  shadows   어두운 부분 올리기(+)/내리기(-)
//  highlights 밝은 부분 올리기(+)/누르기(-)
//  contrast  대비 (S자 곡선 세기)
//  fade      검정을 띄워 바랜 느낌
//  sat       채도 배율 (1 = 그대로)
//  vib       덜 진한 색만 더 진하게
//  mono      흑백 변환 채널 비율 [r, g, b]
//  split     { shadow:[r,g,b], high:[r,g,b] } 어두운/밝은 부분에 더할 색
//  vignette  가장자리 어둡게 (셰이더)
//  grain     필름 입자 (셰이더)

export const FILTERS = [
  { id: 'original', name: '원본', p: {} },
  { id: 'vivid', name: '선명',
    p: { bright: 0.1, shadows: 0.3, contrast: 0.3, sat: 1.2, vib: 0.3 } },
  { id: 'vivid-warm', name: '선명 따뜻',
    p: { bright: 0.12, shadows: 0.35, contrast: 0.32, sat: 1.24, vib: 0.3, temp: 0.55, tint: 0.06,
         split: { shadow: [0.01, 0, -0.01], high: [0.02, 0.008, -0.02] } } },
  { id: 'vivid-cool', name: '선명 시원',
    p: { bright: 0.12, shadows: 0.35, contrast: 0.32, sat: 1.22, vib: 0.3, temp: -0.5, tint: -0.04,
         split: { shadow: [-0.01, 0, 0.015], high: [-0.01, 0.004, 0.02] } } },
  { id: 'dramatic', name: '드라마틱',
    p: { bright: -0.06, highlights: -0.55, contrast: 0.6, sat: 0.8, vignette: 0.18 } },
  { id: 'dramatic-warm', name: '드라마틱 따뜻',
    p: { bright: -0.04, highlights: -0.55, contrast: 0.6, sat: 0.82, temp: 0.6, tint: 0.04,
         split: { shadow: [0.025, 0.01, -0.02], high: [0.02, 0.005, -0.03] }, vignette: 0.18 } },
  { id: 'dramatic-cool', name: '드라마틱 시원',
    p: { bright: -0.04, highlights: -0.55, contrast: 0.6, sat: 0.72, temp: -0.6,
         split: { shadow: [-0.015, 0.005, 0.03], high: [-0.005, 0.005, 0.01] }, vignette: 0.18 } },
  { id: 'mono', name: '흑백',
    p: { mono: [0.3, 0.59, 0.11], contrast: 0.12 } },
  { id: 'silver', name: '은빛',
    p: { mono: [0.32, 0.5, 0.18], bright: 0.15, contrast: 0.55, highlights: 0.25,
         split: { shadow: [-0.006, 0, 0.01], high: [-0.004, 0.002, 0.012] } } },
  { id: 'noir', name: '누아르',
    p: { mono: [0.45, 0.45, 0.1], bright: -0.06, shadows: -0.2, contrast: 1.15, vignette: 0.3, grain: 0.18 } },
  { id: 'film', name: '필름',
    p: { temp: 0.15, contrast: 0.2, fade: 0.55, sat: 0.88, highlights: -0.25,
         split: { shadow: [-0.02, 0.012, 0.03], high: [0.03, 0.012, -0.025] }, grain: 0.32, vignette: 0.1 } },
  { id: 'golden', name: '골든아워',
    p: { bright: 0.06, temp: 0.85, tint: 0.12, contrast: 0.18, sat: 1.12, highlights: -0.3,
         split: { shadow: [0.02, 0.0, -0.02], high: [0.04, 0.02, -0.035] }, vignette: 0.15 } },
  { id: 'fresh', name: '청량',
    p: { bright: 0.28, shadows: 0.3, temp: -0.4, tint: -0.1, contrast: -0.08, fade: 0.12, vib: 0.4,
         split: { shadow: [-0.02, 0.01, 0.03], high: [-0.01, 0.01, 0.015] } } },
  { id: 'vintage', name: '빈티지',
    p: { temp: 0.4, tint: -0.18, contrast: 0.1, fade: 0.7, sat: 0.68, highlights: -0.45,
         split: { shadow: [0.02, 0.03, -0.01], high: [0.04, 0.02, -0.05] }, vignette: 0.35, grain: 0.42 } },
];

export const N = 33; // LUT 한 변 칸 수

const lin = x => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
const gam = x => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
const c01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const S = x => x * x * (3 - 2 * x);

function tone(x, p) {
  if (p.bright) x = 1 - Math.pow(1 - x, Math.pow(2, p.bright));
  if (p.shadows) x += p.shadows * 0.12 * 6.75 * x * (1 - x) * (1 - x);
  if (p.highlights) x += p.highlights * 0.12 * 6.75 * x * x * (1 - x);
  x = c01(x);
  if (p.contrast) x = c01(x + p.contrast * (S(x) - x));
  if (p.fade) {
    const lo = p.fade * 0.12, hi = 1 - p.fade * 0.05;
    x = lo + x * (hi - lo);
  }
  return x;
}

// 색 하나(0~1 sRGB)를 필터에 통과시킨다
export function applyColor(r, g, b, p) {
  // 1) 화이트밸런스 (선형 공간)
  if (p.temp || p.tint) {
    const t = p.temp || 0, n = p.tint || 0;
    let R = lin(r) * (1 + 0.12 * t), G = lin(g) * (1 + 0.02 * t - 0.08 * n), B = lin(b) * (1 - 0.18 * t);
    r = gam(c01(R)); g = gam(c01(G)); b = gam(c01(B));
  }
  // 2) 흑백
  if (p.mono) {
    const [wr, wg, wb] = p.mono, s = wr + wg + wb;
    r = g = b = (wr * r + wg * g + wb * b) / s;
  }
  // 3) 톤 곡선
  r = tone(r, p); g = tone(g, p); b = tone(b, p);
  // 4) 채도 / 생동감
  if (!p.mono && (p.sat !== undefined || p.vib)) {
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const s = Math.max(r, g, b) - Math.min(r, g, b);
    const f = (p.sat ?? 1) * (1 + (p.vib || 0) * (1 - s) * (1 - s));
    r = L + (r - L) * f; g = L + (g - L) * f; b = L + (b - L) * f;
  }
  // 5) 어두운/밝은 부분 색
  if (p.split) {
    const L = c01(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const ws = (1 - L) * (1 - L), wh = L * L;
    const sh = p.split.shadow || [0, 0, 0], hi = p.split.high || [0, 0, 0];
    r += sh[0] * ws + hi[0] * wh; g += sh[1] * ws + hi[1] * wh; b += sh[2] * ws + hi[2] * wh;
  }
  return [c01(r), c01(g), c01(b)];
}

// 모든 필터의 LUT를 한 장에 모은 텍스처 데이터
// 가로: 파랑 칸(N개) x 빨강(N), 세로: 필터마다 초록(N)
export function buildLutAtlas() {
  const W = N * N, H = N * FILTERS.length;
  const data = new Uint8Array(W * H * 4);
  FILTERS.forEach((f, row) => {
    for (let gi = 0; gi < N; gi++) {
      const y = row * N + gi;
      for (let bi = 0; bi < N; bi++) {
        for (let ri = 0; ri < N; ri++) {
          const [r, g, b] = applyColor(ri / (N - 1), gi / (N - 1), bi / (N - 1), f.p);
          const o = (y * W + bi * N + ri) * 4;
          data[o] = Math.round(r * 255);
          data[o + 1] = Math.round(g * 255);
          data[o + 2] = Math.round(b * 255);
          data[o + 3] = 255;
        }
      }
    }
  });
  return { data, width: W, height: H };
}

// 왜곡 효과 (순서 = 셰이더의 번호). c: 화면을 끌면 효과 중심이 따라 움직이는 효과
export const WARPS = [
  { id: 'none', name: '원본' },
  { id: 'bulge', name: '볼록', c: 1 },
  { id: 'dent', name: '오목', c: 1 },
  { id: 'twirl', name: '소용돌이', c: 1 },
  { id: 'squeeze', name: '쥐어짜기', c: 1 },
  { id: 'stretch', name: '늘이기', c: 1 },
  { id: 'mirror', name: '거울', c: 1 },
  { id: 'tunnel', name: '빛의 터널', c: 1 },
  { id: 'fisheye', name: '어안', c: 1, mag: [1, 3], def: (4 / 3 - 1) / 2 },   // 세기 바 = 가운데 배수 ×1~×3 (기본 ×1.33 = 처음 모양), CRT 테두리는 고정
  { id: 'ripple', name: '물결', c: 1 },
  { id: 'kaleido', name: '만화경', c: 1 },
  { id: 'mosaic', name: '모자이크' },
  { id: 'thermal', name: '열화상' },
  { id: 'xray', name: '엑스레이' },
  { id: 'popart', name: '팝아트' },
  { id: 'comic', name: '만화' },
  { id: 'sketch', name: '스케치' },
];
// 3×3 격자 페이지 (가운데가 원본)
export const WARP_PAGES = [
  [1, 2, 3, 4, 0, 5, 6, 7, 8],
  [9, 10, 11, 12, 0, 13, 14, 15, 16],
];
