import { FILTERS, WARPS, WARP_PAGES } from './filters.js?v=9';
import { Renderer } from './renderer.js?v=13';
import { faceReady, loadFace, detectVideo, detectImage, pickFaces, smoothFaces } from './faces.js?v=2';
import { store, newId } from './store.js?v=3';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const TEST = new URLSearchParams(location.search).has('test');
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isMobile = isIOS || /Android|Mobi/i.test(navigator.userAgent);
const DPR = () => Math.min(window.devicePixelRatio || 1, 2);
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const MID = () => [0.5, 0.5];

/* ---------- 설정 (브라우저에 기억) ---------- */
const LS = 'filter-camera:v1';
const settings = Object.assign(
  { filter: 'original', amounts: {}, warp: 'none', warpAmts: {}, ratio: '4:3', timer: 0, grid: false, strip: true, facing: 'environment', deviceId: null },
  (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } })()
);
settings.warpAmts ||= {};
// 어안 배수 범위가 ×1~×3 에서 ×1~×5 로 넓어짐: 예전에 저장한 세기를 같은 배수로 옮김 (배수 = 1 + 2a → a/2)
if (!settings.fish5 && settings.warpAmts.fisheye !== undefined) settings.warpAmts.fisheye /= 2;
settings.fish5 = true;
const saveSettings = () => { try { localStorage.setItem(LS, JSON.stringify(settings)); } catch {} };

const RATIOS = { '4:3': 4 / 3, '1:1': 1, '16:9': 16 / 9 };
const RATIO_ORDER = ['4:3', '1:1', '16:9'];
const TIMERS = [0, 3, 10];
const idxOf = id => Math.max(0, FILTERS.findIndex(f => f.id === id));
const widxOf = id => Math.max(0, WARPS.findIndex(w => w.id === id));
const amountFor = i => settings.amounts[FILTERS[i].id] ?? 1;
const warpAmtFor = i => settings.warpAmts[WARPS[i].id] ?? WARPS[i].def ?? 1;
// 어안: 세기(0~1) <-> 가운데 확대 배율. 바는 0.1배 단위 정수(10 = ×1.0)
const magOf = (i, a) => { const [lo, hi] = WARPS[i].mag; return Math.round((lo + (hi - lo) * a) * 10); };
const amtOfMag = (i, v) => { const [lo, hi] = WARPS[i].mag; return (v / 10 - lo) / (hi - lo); };

const state = {
  mode: 'camera',            // camera | album | edit
  camFilter: idxOf(settings.filter),
  camWarp: widxOf(settings.warp), camCenter: MID(),
  stream: null, camReady: false, mirror: false,
  list: [],
  editRec: null, editBmp: null, editFilter: 0, editAmount: 1, editWarp: 0, editWarpAmt: 1, editCenter: MID(),
  gridOpen: false, gridPage: 0,
  faces: null, editFaces: null,   // 찾은 얼굴 점 (화면 좌표)
  amtTarget: 'color',        // 세기 바가 조절하는 것: color | warp
  timerId: null,
};

/* ---------- 요소 ---------- */
const video = $('#video'), view = $('#view'), frameEl = $('#frame'), stage = $('#stage'), stripEl = $('#strip');
const amountEl = $('#amount'), amt = $('#amt'), amtv = $('#amtv'), warpsEl = $('#warps');
let R, TR, ER;                                   // 화면용, 필터 줄용, 저장용 렌더러
const thumbGL = document.createElement('canvas');
const cropCanvas = document.createElement('canvas');
cropCanvas.width = cropCanvas.height = 160;
const cropCtx = cropCanvas.getContext('2d');
const TH = 56, STEP = 66;                        // 동그라미 지름, 간격 포함 한 칸

const thumbs = FILTERS.map((f, i) => {
  const b = document.createElement('button');
  b.className = 'th';
  b.dataset.i = i;
  b.setAttribute('aria-label', f.name);
  b.title = f.name;
  const c = document.createElement('canvas');
  b.appendChild(c);
  stripEl.appendChild(b);
  return { el: b, canvas: c, ctx: c.getContext('2d') };
});

// 격자: 칸 9개 + 아래 페이지 점
const warpTiles = document.createElement('div');
warpTiles.className = 'wtiles';
const warpBtns = Array.from({ length: 9 }, () => warpTiles.appendChild(document.createElement('button')));
const pageBar = document.createElement('div');
pageBar.className = 'wpages';
const pageDots = WARP_PAGES.map((_, p) => {
  const d = document.createElement('button');
  d.setAttribute('aria-label', `${p + 1}쪽`);
  d.onclick = () => setGridPage(p);
  return pageBar.appendChild(d);
});
warpsEl.append(warpTiles, pageBar);
const PAGE_BAR = 28;   // 페이지 점 띠 높이(px)

const getER = () => (ER ||= new Renderer(document.createElement('canvas'), { preserve: true }));

/* ---------- 지금 고른 색 필터 / 왜곡 ---------- */
const isEdit = () => state.mode === 'edit';
const curFilter = () => (isEdit() ? state.editFilter : state.camFilter);
const curAmount = () => (isEdit() ? state.editAmount : amountFor(state.camFilter));
const curWarp = () => (isEdit() ? state.editWarp : state.camWarp);
const curWarpAmt = () => (isEdit() ? state.editWarpAmt : warpAmtFor(state.camWarp));
const curCenter = () => (isEdit() ? state.editCenter : state.camCenter);
const curFaces = () => (isEdit() ? state.editFaces : state.faces);
const curLook = () => ({ filter: curFilter(), amount: curAmount(), warp: curWarp(), warpAmt: curWarpAmt(), center: curCenter(), faces: curFaces() });

/* ---------- 얼굴 인식 (얼굴 효과를 고르거나 격자 3쪽을 볼 때만 켜짐) ---------- */
const FACE_PAGE = WARP_PAGES.findIndex(pg => pg.some(w => WARPS[w].face));
const faceActive = () => !!WARPS[curWarp()].face || (state.gridOpen && state.gridPage === FACE_PAGE);
let faceLoadShown = false;
function ensureFaceModel() {
  if (faceReady()) return true;
  if (!faceLoadShown) { faceLoadShown = true; showStatus('얼굴 인식 준비 중'); }
  loadFace().then(() => { hideStatus(); requestDraw(); if (isEdit()) findEditFaces(); })
    .catch(e => { console.error(e); faceLoadShown = false; showName('얼굴 인식을 불러오지 못했어요'); });
  return false;
}
let editFaceBusy = false;
async function findEditFaces() {
  if (!isEdit() || !state.editBmp || state.editFaces || editFaceBusy || !faceActive()) return;
  if (!faceReady()) { ensureFaceModel(); return; }
  editFaceBusy = true;
  const rec = state.editRec;
  try {
    const found = pickFaces(await detectImage(state.editBmp));
    if (state.editRec !== rec) return;
    state.editFaces = found;
    if (!found.length) showName('얼굴을 찾지 못했어요');
    scheduleEditSave();
    requestDraw();
  } catch (e) { console.error(e); }
  finally { editFaceBusy = false; }
}

/* ---------- 색 필터 고르기 ---------- */
function setFilter(i, from) {
  i = clamp(i, 0, FILTERS.length - 1);
  const prev = curFilter();
  if (isEdit()) {
    if (i !== prev) { state.editFilter = i; state.editAmount = amountFor(i); scheduleEditSave(); }
  } else {
    state.camFilter = i;
    settings.filter = FILTERS[i].id;
    saveSettings();
  }
  thumbs.forEach((t, k) => t.el.classList.toggle('sel', k === i));
  if (from !== 'scroll') scrollStripTo(i, from === 'init' ? 'auto' : 'smooth');
  if (i !== prev && from !== 'init') { showName(FILTERS[i].name); amountEl.hidden = true; }
  syncAmountUI();
  requestDraw();
}

let stripLock = null;
function scrollStripTo(i, behavior) {
  stripLock = { target: i, until: performance.now() + 800 };
  stripEl.scrollTo({ left: i * STEP, behavior });
}
stripEl.addEventListener('scroll', () => {
  const i = clamp(Math.round(stripEl.scrollLeft / STEP), 0, FILTERS.length - 1);
  if (stripLock) {
    if (i === stripLock.target || performance.now() > stripLock.until) stripLock = null;
    else return;
  }
  if (i !== curFilter()) setFilter(i, 'scroll');
}, { passive: true });

stripEl.addEventListener('click', e => {
  const b = e.target.closest('.th');
  if (!b) return;
  const i = +b.dataset.i;
  if (i === curFilter()) toggleAmount('color');
  else setFilter(i, 'tap');
});

let wheelAcc = 0;
stripEl.addEventListener('wheel', e => {
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  e.preventDefault();
  wheelAcc += e.deltaY;
  if (Math.abs(wheelAcc) >= 40) { setFilter(curFilter() + Math.sign(wheelAcc), 'wheel'); wheelAcc = 0; }
}, { passive: false });

let nameTimer;
function showStatus(text) {   // 사라지지 않는 안내 (얼굴 인식 준비 중)
  const el = $('#fname');
  clearTimeout(nameTimer);
  el.textContent = text;
  el.classList.add('show');
}
function hideStatus() { $('#fname').classList.remove('show'); }
function showName(text) {
  const el = $('#fname');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => el.classList.remove('show'), 1200);
}

/* ---------- 왜곡 고르기 (3×3 격자) ---------- */
function setWarp(i) {
  i = clamp(i, 0, WARPS.length - 1);
  if (isEdit()) {
    if (i !== state.editWarp) { state.editWarp = i; state.editWarpAmt = warpAmtFor(i); state.editCenter = MID(); scheduleEditSave(); }
  } else {
    if (i !== state.camWarp) state.camCenter = MID();
    state.camWarp = i;
    settings.warp = WARPS[i].id;
    saveSettings();
  }
  showName(WARPS[i].name);
  if (state.amtTarget === 'warp') amountEl.hidden = true;
  if (WARPS[i].face) { ensureFaceModel(); findEditFaces(); }
  syncWarpUI();
  requestDraw();
}
function syncWarpUI() {
  const w = curWarp();
  WARP_PAGES[state.gridPage].forEach((wi, k) => {
    const b = warpBtns[k];
    b.dataset.w = wi;
    b.textContent = WARPS[wi].name;
    b.classList.toggle('sel', wi === w);
  });
  pageDots.forEach((d, p) => d.classList.toggle('on', p === state.gridPage));
  $$('.warpbtn').forEach(b => b.classList.toggle('on', w !== 0 || state.gridOpen));
}
function setGridPage(p) {
  state.gridPage = (p + WARP_PAGES.length) % WARP_PAGES.length;
  if (state.gridPage === FACE_PAGE) { ensureFaceModel(); findEditFaces(); }
  syncWarpUI();
  requestDraw();
}
function openGrid() {
  const w = curWarp();
  if (w) state.gridPage = Math.max(0, WARP_PAGES.findIndex(pg => pg.includes(w)));
  state.gridOpen = true;
  warpsEl.hidden = false;
  amountEl.hidden = true;
  syncWarpUI();
  requestDraw();
}
function closeGrid() {
  if (!state.gridOpen) return;
  state.gridOpen = false;
  warpsEl.hidden = true;
  syncWarpUI();
  requestDraw();
}
$$('.warpbtn').forEach(b => b.addEventListener('click', () => (state.gridOpen ? closeGrid() : openGrid())));
// 격자를 좌우로 밀면 페이지 넘기기
let gridSwipe = null, gridSwiped = -1e9;
warpsEl.addEventListener('pointerdown', e => { gridSwipe = { x: e.clientX, y: e.clientY }; });
warpsEl.addEventListener('pointerup', e => {
  if (!gridSwipe) return;
  const dx = e.clientX - gridSwipe.x, dy = e.clientY - gridSwipe.y;
  gridSwipe = null;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    gridSwiped = performance.now();
    setGridPage(state.gridPage + (dx < 0 ? 1 : -1));
  }
});
warpsEl.addEventListener('pointercancel', () => { gridSwipe = null; });
warpTiles.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || performance.now() - gridSwiped < 300) return;
  const w = +b.dataset.w;
  const again = w === curWarp();
  if (!again) setWarp(w);
  closeGrid();
  // 같은 효과를 한 번 더 누르면 세기 바
  if (again && w !== 0) toggleAmount('warp', true);
});

/* ---------- 세기 바 (색 필터 / 왜곡 공용) ---------- */
function toggleAmount(target, forceOpen) {
  if (target === 'color' ? curFilter() === 0 : curWarp() === 0) return;
  const open = forceOpen || amountEl.hidden || state.amtTarget !== target;
  state.amtTarget = target;
  amountEl.hidden = !open;
  if (open) showName(target === 'color' ? FILTERS[curFilter()].name : WARPS[curWarp()].name);
  syncAmountUI();
}
function syncAmountUI() {
  const w = curWarp(), mag = state.amtTarget === 'warp' && WARPS[w].mag;
  if (mag) {
    const v = magOf(w, curWarpAmt()), lo = mag[0] * 10, hi = mag[1] * 10;
    amt.min = lo; amt.max = hi; amt.value = v;
    amtv.textContent = '×' + (v / 10).toFixed(1);
    amt.style.setProperty('--p', ((v - lo) / (hi - lo) * 100) + '%');
    return;
  }
  const v = Math.round((state.amtTarget === 'warp' ? curWarpAmt() : curAmount()) * 100);
  amt.min = 0; amt.max = 100; amt.value = v;
  amtv.textContent = v;
  amt.style.setProperty('--p', v + '%');
}
amt.addEventListener('input', () => {
  const magW = state.amtTarget === 'warp' && WARPS[curWarp()].mag ? curWarp() : 0;
  const a = magW ? amtOfMag(magW, +amt.value) : amt.value / 100;
  if (state.amtTarget === 'warp') {
    if (isEdit()) { state.editWarpAmt = a; scheduleEditSave(); }
    else { settings.warpAmts[WARPS[state.camWarp].id] = a; saveSettings(); }
  } else {
    if (isEdit()) { state.editAmount = a; scheduleEditSave(); }
    else { settings.amounts[FILTERS[state.camFilter].id] = a; saveSettings(); }
  }
  syncAmountUI();
  requestDraw();
});

/* ---------- 화면 크기 ---------- */
function camCrop(vw, vh) {
  let r = RATIOS[settings.ratio];
  if (vh > vw) r = 1 / r;
  const va = vw / vh;
  if (va > r) { const w = r / va; return { x: (1 - w) / 2, y: 0, w, h: 1, aspect: r }; }
  const h = va / r;
  return { x: 0, y: (1 - h) / 2, w: 1, h, aspect: r };
}
function outputAspect() {
  if (isEdit() && state.editBmp) return bmpW(state.editBmp) / bmpH(state.editBmp);
  if (video.videoWidth) return camCrop(video.videoWidth, video.videoHeight).aspect;
  const r = RATIOS[settings.ratio];
  return innerHeight > innerWidth ? 1 / r : r;
}
let lastAspect = 0;
function layout() {
  const sw = stage.clientWidth, sh = stage.clientHeight;
  if (!sw || !sh || !R) return;
  const a = (lastAspect = outputAspect());
  let w = sw, h = sw / a;
  if (h > sh) { h = sh; w = sh * a; }
  w = Math.floor(w); h = Math.floor(h);
  frameEl.style.width = w + 'px';
  frameEl.style.height = h + 'px';
  R.resize(Math.round(w * DPR()), Math.round(h * DPR()));
  requestDraw();
}
new ResizeObserver(() => layout()).observe(stage);
video.addEventListener('resize', () => layout());

/* ---------- 그리기 ---------- */
let drawQueued = false, seed = 0, frameNo = 0, showOriginal = false, faceNext = 0;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawNow(); });
}
const stripVisible = () => isEdit() || settings.strip;

// 3×3 격자: CSS 격자(간격 2px)와 같은 자리에 칸마다 다른 왜곡을 그린다
function drawGrid(base) {
  const W = R.canvas.width, H = R.canvas.height, sc = W / frameEl.clientWidth, g = Math.round(2 * sc);
  const tw = (W - 2 * g) / 3, th = (H - Math.round(PAGE_BAR * sc) - 2 * g) / 3, cw = curWarp();
  R.clear();
  WARP_PAGES[state.gridPage].forEach((wi, k) => {
    const col = k % 3, row = (k / 3) | 0;
    const x = Math.round(col * (tw + g)), y = Math.round(row * (th + g));
    const vp = { x, y, w: Math.round((col + 1) * (tw + g) - g) - x, h: Math.round((row + 1) * (th + g) - g) - y };
    R.draw({ ...base, vp, warp: wi, warpAmt: wi === cw ? curWarpAmt() : warpAmtFor(wi), center: wi === cw ? curCenter() : MID() });
  });
}

function drawNow() {
  if (!R) return;
  if (state.mode === 'camera') {
    if (!state.camReady || video.readyState < 2 || !video.videoWidth) return;
    const vw = video.videoWidth, vh = video.videoHeight, crop = camCrop(vw, vh);
    if (Math.abs(crop.aspect - lastAspect) > 1e-3) layout();
    if (!R.upload(video)) return;
    if (++frameNo % 2 === 0) seed = Math.random();
    // 얼굴 찾기: 오래 걸리는 기기에선 몇 프레임 건너뛰고, 화면은 마지막 얼굴 위치로 계속 그림
    if (faceActive() && ensureFaceModel() && performance.now() >= faceNext) {
      const t0 = performance.now();
      const found = detectVideo(video);
      faceNext = t0 + (performance.now() - t0) * 1.5;
      if (found) state.faces = smoothFaces(state.faces, pickFaces(found, crop, state.mirror));
    }
    const base = { filter: state.camFilter, amount: curAmount(), crop, mirror: state.mirror, seed, faces: state.faces };
    if (state.gridOpen) drawGrid(base);
    else R.draw({ ...base, warp: state.camWarp, warpAmt: curWarpAmt(), center: state.camCenter });
    if (stripVisible()) drawThumbs(video, vw, vh, crop, state.mirror);
  } else if (isEdit() && state.editBmp) {
    if (state.gridOpen) drawGrid({ filter: state.editFilter, amount: state.editAmount, seed: 0.37, faces: state.editFaces });
    else if (showOriginal) R.draw({ filter: 0 });
    else R.draw({ ...curLook(), seed: 0.37 });
  }
}

function drawThumbs(src, sw, sh, crop, mirror) {
  const px = Math.round(TH * DPR()), n = FILTERS.length;
  const cw = crop.w * sw, ch = crop.h * sh, s = Math.min(cw, ch);
  const sx = crop.x * sw + (cw - s) / 2, sy = crop.y * sh + (ch - s) / 2;
  cropCtx.setTransform(mirror ? -1 : 1, 0, 0, 1, mirror ? 160 : 0, 0);
  cropCtx.drawImage(src, sx, sy, s, s, 0, 0, 160, 160);
  TR.resize(px * n, px);
  if (!TR.upload(cropCanvas)) return;
  for (let i = 0; i < n; i++) TR.draw({ filter: i, amount: 1, vp: { x: i * px, y: 0, w: px, h: px }, seed });
  for (let i = 0; i < n; i++) {
    const t = thumbs[i];
    if (t.canvas.width !== px) t.canvas.width = t.canvas.height = px;
    t.ctx.drawImage(thumbGL, i * px, 0, px, px, 0, 0, px, px);
  }
}

/* ---------- 카메라 ---------- */
let camToken = 0, loopToken = 0, cams = [];
const nextFrame = f => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(f) : requestAnimationFrame(f));

function showMsg(text) {
  const m = $('#msg');
  m.hidden = !text;
  if (text) m.querySelector('p').textContent = text;
}

async function startCamera() {
  const tok = ++camToken;
  stopCamera(true);
  showMsg(null);
  if (!navigator.mediaDevices?.getUserMedia) {
    showMsg(location.protocol === 'https:' || location.hostname === 'localhost' ? '이 브라우저에선 카메라를 쓸 수 없어요' : 'https 주소에서만 카메라가 켜져요');
    return;
  }
  const size = { width: { ideal: 2560 }, height: { ideal: 1440 } };
  const want = isMobile || !settings.deviceId
    ? { facingMode: { ideal: settings.facing }, ...size }
    : { deviceId: { exact: settings.deviceId }, ...size };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: want });
  } catch (e) {
    if (e.name === 'OverconstrainedError' || e.name === 'NotFoundError') {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: size }); } catch (e2) { e = e2; }
    }
    if (!stream) {
      if (tok === camToken) showMsg(e.name === 'NotAllowedError' ? '카메라 권한을 허용해 주세요' : e.name === 'NotFoundError' ? '카메라를 찾지 못했어요' : '카메라를 켤 수 없어요');
      return;
    }
  }
  if (tok !== camToken || state.mode !== 'camera' || document.hidden) {
    stream.getTracks().forEach(t => t.stop());
    return;
  }
  state.stream = stream;
  const track = stream.getVideoTracks()[0];
  const st = track.getSettings ? track.getSettings() : {};
  state.mirror = st.facingMode ? st.facingMode === 'user' : !isMobile || settings.facing === 'user';
  if (!isMobile && st.deviceId) settings.deviceId = st.deviceId;
  video.srcObject = stream;
  try { await video.play(); } catch {}
  if (tok !== camToken) return;
  state.camReady = true;
  layout();
  const lt = ++loopToken;
  const step = () => {
    if (lt !== loopToken || state.mode !== 'camera' || !state.camReady) return;
    drawNow();
    nextFrame(step);
  };
  nextFrame(step);
  listCameras();
}

function stopCamera(keepToken) {
  if (!keepToken) camToken++;
  state.camReady = false;
  loopToken++;
  if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
  video.srcObject = null;
}

async function listCameras() {
  try {
    cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  } catch { cams = []; }
  $('#bFlip').classList.toggle('gone', !isMobile && cams.length < 2);
}

$('#bFlip').addEventListener('click', () => {
  if (isMobile) settings.facing = settings.facing === 'user' ? 'environment' : 'user';
  else if (cams.length > 1) {
    const i = cams.findIndex(c => c.deviceId === settings.deviceId);
    settings.deviceId = cams[(i + 1) % cams.length].deviceId;
  }
  saveSettings();
  startCamera();
});
$('#bRetry').addEventListener('click', () => startCamera());

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { cancelTimer(); stopCamera(); }
  else if (state.mode === 'camera' && !TEST) startCamera();
});

/* ---------- 찍기 ---------- */
$('#bShutter').addEventListener('click', () => {
  if (state.gridOpen) { closeGrid(); return; }
  if (state.timerId) { cancelTimer(); return; }
  if (!state.camReady) return;
  if (settings.timer) runTimer(settings.timer);
  else capture();
});

function runTimer(n) {
  const el = $('#count');
  let left = n;
  $('#bShutter').classList.add('timing');
  const tick = () => {
    if (left === 0) { cancelTimer(); capture(); return; }
    el.textContent = left;
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
    left--;
    state.timerId = setTimeout(tick, 1000);
  };
  tick();
}
function cancelTimer() {
  clearTimeout(state.timerId);
  state.timerId = null;
  $('#count').textContent = '';
  $('#bShutter').classList.remove('timing');
}

const toBlob = (c, type = 'image/jpeg', q = 0.92) =>
  new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('toBlob 실패'))), type, q));
const bmpW = b => b.naturalWidth || b.width;
const bmpH = b => b.naturalHeight || b.height;

// 저장용 원본 크기 렌더 (그리기 + toBlob 호출까지는 동기라 겹쳐도 안전)
function renderFull(src, look) {
  const er = getER();
  er.resize(bmpW(src), bmpH(src));
  er.upload(src);
  er.draw({ ...look, seed: 0.37 });
  const p = toBlob(er.canvas, 'image/jpeg', 0.92);
  er.resize(1, 1);
  return p;
}
// 사진첩 칸: 효과를 입힌 전체 그림을 작게 그린 뒤 가운데를 정사각형으로
const thumbCanvas = document.createElement('canvas');
thumbCanvas.width = thumbCanvas.height = 240;
function makeThumb(src, look) {
  const er = getER(), w = bmpW(src), h = bmpH(src), k = 240 / Math.min(w, h);
  const W = Math.max(240, Math.round(w * k)), H = Math.max(240, Math.round(h * k));
  er.resize(W, H);
  er.upload(src);
  er.draw({ ...look, seed: 0.37 });
  thumbCanvas.getContext('2d').drawImage(er.canvas, (W - 240) / 2, (H - 240) / 2, 240, 240, 0, 0, 240, 240);
  return toBlob(thumbCanvas, 'image/jpeg', 0.85);
}

let busy = false;
async function capture() {
  if (busy || !state.camReady) return;
  busy = true;
  try {
    const vw = video.videoWidth, vh = video.videoHeight, crop = camCrop(vw, vh);
    const W = Math.round(crop.w * vw), H = Math.round(crop.h * vh);
    const oc = document.createElement('canvas');
    oc.width = W; oc.height = H;
    const ctx = oc.getContext('2d');
    if (state.mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, crop.x * vw, crop.y * vh, W, H, 0, 0, W, H);
    flash();
    const look = { ...curLook(), center: [...state.camCenter], faces: state.faces && JSON.parse(JSON.stringify(state.faces)) }, created = Date.now();
    const thumbP = makeThumb(oc, look);
    const outP = isIOS ? null : renderFull(oc, look);
    const original = await toBlob(oc, 'image/jpeg', 0.95);
    const rec = {
      id: newId(), created, w: W, h: H,
      filter: FILTERS[look.filter].id, amount: look.amount,
      warp: WARPS[look.warp].id, warpAmt: look.warpAmt, center: look.center, fish5: true, faces: look.faces || null,
      original, thumb: await thumbP,
    };
    await store.put(rec);
    state.list.unshift(rec);
    setAlbumThumb(rec.thumb);
    if (outP) deliver(await outP, fileName(created));
  } catch (e) {
    console.error(e);
  } finally {
    busy = false;
  }
}

function flash() {
  const f = $('#flash');
  f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
}

const pad = n => String(n).padStart(2, '0');
function fileName(t) {
  const d = new Date(t);
  return `filter_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;
}

// 폰(iOS)은 공유 창으로 "이미지 저장", 나머지는 파일로 내려받기
let pendingShare = null;
async function deliver(blob, name) {
  if (TEST) { (window.__exports ||= []).push({ name, size: blob.size, type: blob.type, blob }); return true; }
  if (isIOS) {
    const file = new File([blob], name, { type: 'image/jpeg' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return true; }
      catch (e) {
        if (e.name === 'AbortError') return false;
        if (e.name === 'NotAllowedError') { pendingShare = file; $('#bSave').classList.add('done'); return false; }
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  return true;
}

/* ---------- 사진첩 ---------- */
let albumUrl = null, tileUrls = [];
function setAlbumThumb(blob) {
  const img = $('#bAlbum img');
  if (albumUrl) URL.revokeObjectURL(albumUrl);
  albumUrl = blob ? URL.createObjectURL(blob) : null;
  if (albumUrl) img.src = albumUrl; else img.removeAttribute('src');
}
async function refreshList() {
  try { state.list = await store.all(); } catch { state.list = []; }
  setAlbumThumb(state.list[0]?.thumb);
}

function setMode(m) {
  state.mode = m;
  document.body.dataset.mode = m;
  $('#album').hidden = m !== 'album';
  amountEl.hidden = true;
  showOriginal = false;
  state.gridOpen = false;
  warpsEl.hidden = true;
  if (m === 'camera') {
    setFilter(state.camFilter, 'init');
    syncWarpUI();
    layout();
    if (!TEST) startCamera();
  } else {
    cancelTimer();
    stopCamera();
  }
}

async function openAlbum() {
  setMode('album');
  await refreshList();
  renderTiles();
}
function renderTiles() {
  tileUrls.forEach(u => URL.revokeObjectURL(u));
  tileUrls = [];
  const box = $('#tiles');
  box.textContent = '';
  const add = document.createElement('button');
  add.className = 'tile add';
  add.setAttribute('aria-label', '사진 불러오기');
  add.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
  add.onclick = () => $('#file').click();
  box.appendChild(add);
  for (const rec of state.list) {
    const b = document.createElement('button');
    b.className = 'tile';
    b.setAttribute('aria-label', '사진 열기');
    const img = document.createElement('img');
    const u = URL.createObjectURL(rec.thumb);
    tileUrls.push(u);
    img.src = u; img.alt = '';
    b.appendChild(img);
    b.onclick = () => openEditor(rec.id);
    box.appendChild(b);
  }
}

$('#bAlbum').addEventListener('click', openAlbum);
$('#bAlbumBack').addEventListener('click', () => setMode('camera'));

$('#file').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) await importFiles(files);
});

async function decode(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch {}
  try { return await createImageBitmap(blob); } catch {}
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  await img.decode();
  URL.revokeObjectURL(url);
  return img;
}

async function importFiles(files) {
  const MAX = Math.min(4096, getER().maxTex || 4096);
  let last = null, done = 0;
  for (const f of files) {
    if (f.type && !f.type.startsWith('image/')) continue;
    try {
      const bmp = await decode(f);
      const k = Math.min(1, MAX / Math.max(bmpW(bmp), bmpH(bmp)));
      const W = Math.round(bmpW(bmp) * k), H = Math.round(bmpH(bmp) * k);
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(bmp, 0, 0, W, H);
      bmp.close?.();
      const thumbP = makeThumb(c, { filter: 0 });
      const rec = { id: newId(), created: f.lastModified || Date.now(), w: W, h: H,
        filter: 'original', amount: 1, warp: 'none', warpAmt: 1, center: MID(), fish5: true,
        original: await toBlob(c, 'image/jpeg', 0.95), thumb: await thumbP };
      await store.put(rec);
      last = rec.id; done++;
    } catch (e) {
      console.warn('불러오기 실패', f.name, e);
    }
  }
  await refreshList();
  renderTiles();
  if (done === 1 && last) openEditor(last);
}

/* ---------- 편집 ---------- */
async function openEditor(id) {
  flushEditSave();
  const rec = state.list.find(r => r.id === id) || (await store.get(id));
  if (!rec) return;
  const bmp = await decode(rec.original);
  state.editBmp?.close?.();
  state.editRec = rec;
  state.editBmp = bmp;
  state.editFilter = idxOf(rec.filter);
  state.editAmount = rec.amount ?? 1;
  state.editWarp = widxOf(rec.warp);
  state.editWarpAmt = rec.warpAmt ?? 1;
  if (rec.warp === 'fisheye' && !rec.fish5 && rec.warpAmt !== undefined) state.editWarpAmt = rec.warpAmt / 2;   // ×1~×3 시절 기록
  state.editCenter = rec.center ? [...rec.center] : MID();
  state.editFaces = rec.faces || null;
  pendingShare = null;
  $('#bSave').classList.remove('done');
  setMode('edit');
  R.upload(bmp);
  thumbs.forEach((t, k) => t.el.classList.toggle('sel', k === state.editFilter));
  scrollStripTo(state.editFilter, 'auto');
  syncWarpUI();
  syncAmountUI();
  layout();
  drawThumbs(bmp, bmpW(bmp), bmpH(bmp), FULL, false);
  findEditFaces();
}

let editSaveT = null;
const deletedIds = new Set();   // 지운 뒤 늦게 끝난 저장이 사진을 되살리지 않게
function scheduleEditSave() {
  clearTimeout(editSaveT);
  editSaveT = setTimeout(flushEditSave, 400);
  pendingShare = null;
  $('#bSave').classList.remove('done');
}
function flushEditSave() {
  if (!editSaveT) return;
  clearTimeout(editSaveT);
  editSaveT = null;
  const rec = state.editRec, bmp = state.editBmp;
  if (!rec || !bmp) return;
  const look = { filter: state.editFilter, amount: state.editAmount, warp: state.editWarp, warpAmt: state.editWarpAmt, center: [...state.editCenter], faces: state.editFaces };
  rec.filter = FILTERS[look.filter].id;
  rec.amount = look.amount;
  rec.warp = WARPS[look.warp].id;
  rec.warpAmt = look.warpAmt;
  rec.center = look.center;
  rec.fish5 = true;
  rec.faces = state.editFaces || null;
  store.put(rec).catch(console.error);            // 고른 효과는 바로 저장, 사진첩 칸 그림은 뒤따라
  makeThumb(bmp, look).then(async thumb => {
    if (deletedIds.has(rec.id)) return;
    rec.thumb = thumb;
    await store.put(rec);
    if (state.list[0]?.id === rec.id) setAlbumThumb(thumb);
  }).catch(console.error);
}

function backToAlbum() {
  flushEditSave();
  openAlbum();
}
$('#bBack').addEventListener('click', backToAlbum);

$('#bDelete').addEventListener('click', async () => {
  const rec = state.editRec;
  if (!rec || !confirm('이 사진을 지울까요?')) return;
  clearTimeout(editSaveT);
  editSaveT = null;
  deletedIds.add(rec.id);
  await store.del(rec.id);
  const i = state.list.findIndex(r => r.id === rec.id);
  if (i >= 0) state.list.splice(i, 1);
  setAlbumThumb(state.list[0]?.thumb);
  const next = state.list[i] || state.list[i - 1];
  state.editRec = null;
  if (next) openEditor(next.id);
  else openAlbum();
});

$('#bSave').addEventListener('click', async () => {
  const btn = $('#bSave');
  if (pendingShare) {
    const f = pendingShare;
    pendingShare = null;
    btn.classList.remove('done');
    try { await navigator.share({ files: [f] }); } catch {}
    return;
  }
  if (!state.editBmp) return;
  flushEditSave();
  const blob = await renderFull(state.editBmp, curLook());
  if (await deliver(blob, fileName(state.editRec.created))) {
    btn.classList.add('done');
    btn.querySelector('use').setAttribute('href', '#i-check');
    setTimeout(() => {
      btn.classList.remove('done');
      btn.querySelector('use').setAttribute('href', '#i-save');
    }, 1200);
  }
});

/* ---------- 화면 손가락 동작 ----------
   왜곡이 켜져 있으면: 끌어서 효과 중심 옮기기
   왜곡이 없으면: 좌우로 밀어 색 필터 바꾸기
   편집 중 꾹 누르면: 원본 보기 */
let ptr = null;
stage.addEventListener('pointerdown', e => {
  if (state.gridOpen || e.target.closest('#amount, #msg')) return;
  ptr = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, hold: null, drag: !!WARPS[curWarp()].c };
  if (ptr.drag) { try { stage.setPointerCapture(e.pointerId); } catch {} }
  if (isEdit()) ptr.hold = setTimeout(() => { showOriginal = true; requestDraw(); }, 220);
});
stage.addEventListener('pointermove', e => {
  if (!ptr) return;
  if (!ptr.moved && Math.hypot(e.clientX - ptr.x, e.clientY - ptr.y) > 10) {
    ptr.moved = true;
    clearTimeout(ptr.hold);
    if (ptr.drag) { stage.classList.add('dragging'); if (showOriginal) { showOriginal = false; } }
  }
  if (ptr.drag && ptr.moved) {
    const fw = frameEl.clientWidth, fh = frameEl.clientHeight, c = curCenter();
    c[0] = clamp(c[0] + (e.clientX - ptr.lx) / fw, 0, 1);
    c[1] = clamp(c[1] + (e.clientY - ptr.ly) / fh, 0, 1);
    if (isEdit()) scheduleEditSave();
    requestDraw();
  }
  ptr.lx = e.clientX;
  ptr.ly = e.clientY;
});
function endPtr(e) {
  if (!ptr) return;
  clearTimeout(ptr.hold);
  stage.classList.remove('dragging');
  const wasOriginal = showOriginal;
  if (showOriginal) { showOriginal = false; requestDraw(); }
  const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y;
  if (e.type === 'pointerup') {
    if (!ptr.drag && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) setFilter(curFilter() + (dx < 0 ? 1 : -1), 'swipe');
    else if (!ptr.moved && !wasOriginal && !amountEl.hidden) amountEl.hidden = true;
  }
  ptr = null;
}
stage.addEventListener('pointerup', endPtr);
stage.addEventListener('pointercancel', endPtr);
stage.addEventListener('contextmenu', e => e.preventDefault());

// 마우스 휠, ↑↓ 키로 세기 조절 (어안은 0.1배씩). 위로 = 숫자 커짐
function nudgeAmount(dir) {
  const target = curWarp() ? 'warp' : curFilter() ? 'color' : null;
  if (!target) return;
  if (amountEl.hidden || state.amtTarget !== target) toggleAmount(target, true);
  const mag = target === 'warp' && WARPS[curWarp()].mag;
  amt.value = mag ? clamp(+amt.value + dir, mag[0] * 10, mag[1] * 10) : clamp(+amt.value + dir * 5, 0, 100);
  amt.dispatchEvent(new Event('input'));
}
let stageWheel = 0;
stage.addEventListener('wheel', e => {
  if (state.gridOpen) return;
  e.preventDefault();
  stageWheel += e.deltaY;
  if (Math.abs(stageWheel) >= 40) { nudgeAmount(stageWheel < 0 ? 1 : -1); stageWheel = 0; }
}, { passive: false });
if (!isMobile) amountEl.title = '마우스 휠, ↑↓ 키로도 조절';

/* ---------- 위쪽 버튼 ---------- */
function applySettingsUI() {
  document.body.classList.toggle('nostrip', !settings.strip);
  $('#bStrip').classList.toggle('on', settings.strip);
  $('#bRatio').textContent = settings.ratio;
  $('#bTimer').classList.toggle('on', !!settings.timer);
  $('#bTimer .badge').textContent = settings.timer || '';
  $('#bGrid').classList.toggle('on', settings.grid);
  $('#grid').hidden = !settings.grid;
}
$('#bStrip').addEventListener('click', () => {
  settings.strip = !settings.strip;
  saveSettings(); applySettingsUI();
  if (settings.strip) requestAnimationFrame(() => scrollStripTo(curFilter(), 'auto'));
});
$('#bRatio').addEventListener('click', () => {
  settings.ratio = RATIO_ORDER[(RATIO_ORDER.indexOf(settings.ratio) + 1) % RATIO_ORDER.length];
  saveSettings(); applySettingsUI(); layout();
});
$('#bTimer').addEventListener('click', () => {
  settings.timer = TIMERS[(TIMERS.indexOf(settings.timer) + 1) % TIMERS.length];
  saveSettings(); applySettingsUI();
});
$('#bGrid').addEventListener('click', () => {
  settings.grid = !settings.grid;
  saveSettings(); applySettingsUI();
});

/* ---------- 키보드 ---------- */
addEventListener('keydown', e => {
  if (e.target.matches?.('input') && e.key !== 'Escape') return;
  if (state.mode === 'album') { if (e.key === 'Escape') setMode('camera'); return; }
  if (state.gridOpen) {
    if (e.key === 'Escape') closeGrid();
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') setGridPage(state.gridPage + (e.key === 'ArrowRight' ? 1 : -1));
    if (e.key === 'Escape' || e.key.startsWith('Arrow')) return;
  }
  if (e.key === 'ArrowRight') setFilter(curFilter() + 1, 'key');
  else if (e.key === 'ArrowLeft') setFilter(curFilter() - 1, 'key');
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); nudgeAmount(e.key === 'ArrowUp' ? 1 : -1); }
  else if (e.key === 'Escape' && isEdit()) backToAlbum();
  else if ((e.key === ' ' || e.key === 'Enter') && state.mode === 'camera' && !e.target.closest?.('button')) {
    e.preventDefault();
    $('#bShutter').click();
  }
});

/* ---------- 시작 ---------- */
function init() {
  try {
    R = new Renderer(view);
    TR = new Renderer(thumbGL, { preserve: true });
  } catch (e) {
    console.error(e);
    showMsg('이 기기에선 필터를 그릴 수 없어요');
    return;
  }
  applySettingsUI();
  setFilter(state.camFilter, 'init');
  syncWarpUI();
  layout();
  refreshList();
  if (!TEST) startCamera();
}
init();

if (TEST) window.fc = { state, settings, startCamera, capture, openAlbum, openEditor, importFiles, setFilter, setWarp, openGrid, closeGrid, setMode, store, FILTERS, WARPS };
