import { FILTERS } from './filters.js?v=1';
import { Renderer } from './renderer.js?v=1';
import { store, newId } from './store.js?v=1';

const $ = s => document.querySelector(s);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const TEST = new URLSearchParams(location.search).has('test');
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isMobile = isIOS || /Android|Mobi/i.test(navigator.userAgent);
const DPR = () => Math.min(window.devicePixelRatio || 1, 2);
const FULL = { x: 0, y: 0, w: 1, h: 1 };

/* ---------- 설정 (브라우저에 기억) ---------- */
const LS = 'filter-camera:v1';
const settings = Object.assign(
  { filter: 'original', amounts: {}, ratio: '4:3', timer: 0, grid: false, strip: true, facing: 'environment', deviceId: null },
  (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } })()
);
const saveSettings = () => { try { localStorage.setItem(LS, JSON.stringify(settings)); } catch {} };

const RATIOS = { '4:3': 4 / 3, '1:1': 1, '16:9': 16 / 9 };
const RATIO_ORDER = ['4:3', '1:1', '16:9'];
const TIMERS = [0, 3, 10];
const idxOf = id => Math.max(0, FILTERS.findIndex(f => f.id === id));
const amountFor = i => settings.amounts[FILTERS[i].id] ?? 1;

const state = {
  mode: 'camera',            // camera | album | edit
  camFilter: idxOf(settings.filter),
  stream: null, camReady: false, mirror: false,
  list: [],
  editRec: null, editBmp: null, editFilter: 0, editAmount: 1,
  timerId: null,
};

/* ---------- 요소 ---------- */
const video = $('#video'), view = $('#view'), frameEl = $('#frame'), stage = $('#stage'), stripEl = $('#strip');
const amountEl = $('#amount'), amt = $('#amt'), amtv = $('#amtv');
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

const getER = () => (ER ||= new Renderer(document.createElement('canvas'), { preserve: true }));

/* ---------- 필터 고르기 ---------- */
const curFilter = () => (state.mode === 'edit' ? state.editFilter : state.camFilter);
const curAmount = () => (state.mode === 'edit' ? state.editAmount : amountFor(state.camFilter));

function setFilter(i, from) {
  i = clamp(i, 0, FILTERS.length - 1);
  const prev = curFilter();
  if (state.mode === 'edit') {
    if (i !== prev) { state.editFilter = i; state.editAmount = amountFor(i); scheduleEditSave(); }
  } else {
    state.camFilter = i;
    settings.filter = FILTERS[i].id;
    saveSettings();
  }
  thumbs.forEach((t, k) => t.el.classList.toggle('sel', k === i));
  if (from !== 'scroll') scrollStripTo(i, from === 'init' ? 'auto' : 'smooth');
  if (i !== prev && from !== 'init') { showName(i); amountEl.hidden = true; }
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
  if (i === curFilter()) toggleAmount();
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
function showName(i) {
  const el = $('#fname');
  el.textContent = FILTERS[i].name;
  el.classList.add('show');
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => el.classList.remove('show'), 1200);
}

/* ---------- 필터 세기 ---------- */
function toggleAmount() {
  if (curFilter() === 0) return;
  amountEl.hidden = !amountEl.hidden;
  syncAmountUI();
}
function syncAmountUI() {
  const v = Math.round(curAmount() * 100);
  amt.value = v;
  amtv.textContent = v;
  amt.style.setProperty('--p', v + '%');
}
amt.addEventListener('input', () => {
  const a = amt.value / 100;
  if (state.mode === 'edit') { state.editAmount = a; scheduleEditSave(); }
  else { settings.amounts[FILTERS[state.camFilter].id] = a; saveSettings(); }
  amtv.textContent = amt.value;
  amt.style.setProperty('--p', amt.value + '%');
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
  if (state.mode === 'edit' && state.editBmp) return bmpW(state.editBmp) / bmpH(state.editBmp);
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
let drawQueued = false, seed = 0, frameNo = 0, showOriginal = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawNow(); });
}
const stripVisible = () => state.mode === 'edit' || settings.strip;

function drawNow() {
  if (!R) return;
  if (state.mode === 'camera') {
    if (!state.camReady || video.readyState < 2 || !video.videoWidth) return;
    const vw = video.videoWidth, vh = video.videoHeight, crop = camCrop(vw, vh);
    if (Math.abs(crop.aspect - lastAspect) > 1e-3) layout();
    if (!R.upload(video)) return;
    if (++frameNo % 2 === 0) seed = Math.random();
    R.draw({ filter: state.camFilter, amount: curAmount(), crop, mirror: state.mirror, seed });
    if (stripVisible()) drawThumbs(video, vw, vh, crop, state.mirror);
  } else if (state.mode === 'edit' && state.editBmp) {
    R.draw({ filter: showOriginal ? 0 : state.editFilter, amount: state.editAmount, seed: 0.37 });
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
function renderFull(src, filter, amount) {
  const er = getER();
  er.resize(bmpW(src), bmpH(src));
  er.upload(src);
  er.draw({ filter, amount, seed: 0.37 });
  const p = toBlob(er.canvas, 'image/jpeg', 0.92);
  er.resize(1, 1);
  return p;
}
function makeThumb(src, filter, amount) {
  const er = getER(), w = bmpW(src), h = bmpH(src), s = Math.min(w, h), T = 240;
  er.resize(T, T);
  er.upload(src);
  er.draw({ filter, amount, crop: { x: (1 - s / w) / 2, y: (1 - s / h) / 2, w: s / w, h: s / h }, seed: 0.37 });
  return toBlob(er.canvas, 'image/jpeg', 0.85);
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
    const filter = state.camFilter, amount = curAmount(), created = Date.now();
    const thumbP = makeThumb(oc, filter, amount);
    const outP = isIOS ? null : renderFull(oc, filter, amount);
    const original = await toBlob(oc, 'image/jpeg', 0.95);
    const rec = { id: newId(), created, w: W, h: H, filter: FILTERS[filter].id, amount, original, thumb: await thumbP };
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
  if (m === 'camera') {
    setFilter(state.camFilter, 'init');
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
      const thumbP = makeThumb(c, 0, 1);
      const rec = { id: newId(), created: f.lastModified || Date.now(), w: W, h: H, filter: 'original', amount: 1,
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
  pendingShare = null;
  $('#bSave').classList.remove('done');
  setMode('edit');
  R.upload(bmp);
  thumbs.forEach((t, k) => t.el.classList.toggle('sel', k === state.editFilter));
  scrollStripTo(state.editFilter, 'auto');
  syncAmountUI();
  layout();
  drawThumbs(bmp, bmpW(bmp), bmpH(bmp), FULL, false);
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
  rec.filter = FILTERS[state.editFilter].id;
  rec.amount = state.editAmount;
  const p = makeThumb(bmp, state.editFilter, state.editAmount);
  p.then(async thumb => {
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
  const blob = await renderFull(state.editBmp, state.editFilter, state.editAmount);
  if (await deliver(blob, fileName(state.editRec.created))) {
    btn.classList.add('done');
    btn.querySelector('use').setAttribute('href', '#i-check');
    setTimeout(() => {
      btn.classList.remove('done');
      btn.querySelector('use').setAttribute('href', '#i-save');
    }, 1200);
  }
});

/* ---------- 화면 손가락 동작: 좌우로 밀면 필터, 편집 중 꾹 누르면 원본 ---------- */
let ptr = null;
stage.addEventListener('pointerdown', e => {
  if (e.target.closest('#amount, #msg')) return;
  ptr = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false, hold: null };
  if (state.mode === 'edit') ptr.hold = setTimeout(() => { showOriginal = true; requestDraw(); }, 220);
});
stage.addEventListener('pointermove', e => {
  if (!ptr || ptr.moved) return;
  if (Math.hypot(e.clientX - ptr.x, e.clientY - ptr.y) > 10) { ptr.moved = true; clearTimeout(ptr.hold); }
});
function endPtr(e) {
  if (!ptr) return;
  clearTimeout(ptr.hold);
  const wasOriginal = showOriginal;
  if (showOriginal) { showOriginal = false; requestDraw(); }
  const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y;
  if (e.type === 'pointerup') {
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) setFilter(curFilter() + (dx < 0 ? 1 : -1), 'swipe');
    else if (!ptr.moved && !wasOriginal && !amountEl.hidden) amountEl.hidden = true;
  }
  ptr = null;
}
stage.addEventListener('pointerup', endPtr);
stage.addEventListener('pointercancel', endPtr);
stage.addEventListener('contextmenu', e => e.preventDefault());

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
  if (e.target.matches('input') && e.key !== 'Escape') return;
  if (state.mode === 'album') { if (e.key === 'Escape') setMode('camera'); return; }
  if (e.key === 'ArrowRight') setFilter(curFilter() + 1, 'key');
  else if (e.key === 'ArrowLeft') setFilter(curFilter() - 1, 'key');
  else if (e.key === 'Escape' && state.mode === 'edit') backToAlbum();
  else if ((e.key === ' ' || e.key === 'Enter') && state.mode === 'camera' && !e.target.closest('button')) {
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
  layout();
  refreshList();
  if (!TEST) startCamera();
}
init();

if (TEST) window.fc = { state, settings, startCamera, capture, openAlbum, openEditor, importFiles, setFilter, setMode, store, FILTERS };
