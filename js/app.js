/* 操作画面：カメラで顔を判定し、6つの表情 × 口の3段階（閉・半・開）＝18枚の画像を切り替える。 */
import { FilesetResolver, FaceLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LS_KEY = 'kaochara.settings.v1';
const ch = new BroadcastChannel(CHANNEL);
const stage = new Stage($('#cv'), { hint: true });
window.__stage = stage;

/* ---------- 設定（このブラウザに保存） ---------- */
const DEFAULTS = {
  thr: { ...DETECT.DEFAULT_THR }, base: null, basePose: null, holdMs: 150,
  bg: '#00ff00', x: 0, y: 0, scale: 1, motion: 0.6, bounce: true, mirror: true, monitor: true, camId: '',
};
let S = load();
function load() {
  let s = {}; try { s = JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) {}
  return { ...DEFAULTS, ...s, thr: { ...DEFAULTS.thr, ...(s.thr || {}) } };
}
let saveTimer = 0;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {} }, 300); };

/* ---------- 通知 ---------- */
let toastTimer = 0;
function toast(msg, isErr) {
  const t = $('#toast'); t.textContent = msg; t.className = isErr ? 'err' : '';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hide'), isErr ? 8000 : 3500);
}
function pill(id, text, kind) { const p = $(id); p.textContent = text; p.className = 'pill ' + kind; }

/* ---------- 出力画面との通信 ---------- */
let lastStageSeen = 0;
const config = () => ({ bg: S.bg, x: S.x, y: S.y, scale: S.scale });
function sendConfig() { stage.setConfig(config()); ch.postMessage({ type: 'config', config: config() }); }
let state = { emotion: 'normal', mouth: 'closed', rot: 0, dx: 0, dy: 0 }, sentState = '';
function sendState(s) {
  state = s; stage.setState(s);
  const key = `${s.emotion}|${s.mouth}|${s.rot.toFixed(1)}|${Math.round(s.dx)}|${Math.round(s.dy)}`;
  if (key !== sentState) { sentState = key; ch.postMessage({ type: 'state', state: s }); }
}
ch.onmessage = ev => {
  const m = ev.data; if (!m) return;
  if (m.type === 'hb' || m.type === 'hello') lastStageSeen = Date.now();
  if (m.type === 'hello') { ch.postMessage({ type: 'config', config: config() }); ch.postMessage({ type: 'state', state }); }
};
setInterval(() => { const ok = Date.now() - lastStageSeen < 2500; pill('#stageStatus', ok ? '出力画面：接続中' : '出力画面：未接続', ok ? 'ok' : 'ng'); }, 1000);

/* ---------- 顔判定（MediaPipe Face Landmarker） ---------- */
let landmarker = null, stream = null, running = false;
const video = $('#video');
async function initModel() {
  pill('#camStatus', '顔判定：準備中…', 'wait');
  const fs = await FilesetResolver.forVisionTasks(new URL('../vendor/mediapipe/wasm', import.meta.url).href);
  const opts = delegate => ({
    baseOptions: { modelAssetPath: new URL('../vendor/mediapipe/face_landmarker.task', import.meta.url).href, delegate },
    runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
  });
  try { landmarker = await FaceLandmarker.createFromOptions(fs, opts('GPU')); }
  catch (e) { console.warn('GPU が使えないため CPU で動かします', e); landmarker = await FaceLandmarker.createFromOptions(fs, opts('CPU')); }
  pill('#camStatus', '顔判定：カメラ停止中', 'wait');
  $('#btnCam').disabled = false;
}
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('このページではカメラを使えません。https:// で始まるURLから開いてください。', true); return; }
  stopCamera();
  const video_ = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } };
  if (S.camId) video_.deviceId = { exact: S.camId }; else video_.facingMode = 'user';
  try { stream = await navigator.mediaDevices.getUserMedia({ video: video_, audio: false }); }
  catch (e) {
    if (S.camId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) { S.camId = ''; save(); return startCamera(); }
    const msg = { NotAllowedError: 'カメラの使用が許可されていません。アドレスバー左のカメラのマークから「許可」にしてください。',
      NotFoundError: 'カメラが見つかりません。', NotReadableError: 'カメラを開けません。Zoom など、ほかのアプリがカメラを使っていないか確認してください。' }[e.name];
    toast(msg || 'カメラを開けませんでした：' + e.message, true); return;
  }
  video.srcObject = stream; await video.play().catch(() => {});
  running = true; judge.reset(); lastSeen = performance.now();
  $('#btnCam').textContent = '■ カメラ停止'; $('#btnCam').classList.remove('primary');
  listCameras();
  schedule();
}
function stopCamera() {
  running = false;
  if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null;
  $('#btnCam').textContent = '▶ カメラ開始'; $('#btnCam').classList.add('primary');
  if (landmarker) pill('#camStatus', '顔判定：カメラ停止中', 'wait');
  $('#monLabel').textContent = 'カメラ停止中'; $('#monLabel').className = '';
  if (typeof og !== 'undefined') { og.clearRect(0, 0, ov.width, ov.height); updateGuide(null); }
}
async function listCameras() {
  try {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    const sel = $('#selCam'); sel.textContent = '';
    const o0 = el('option', '', '標準のカメラ'); o0.value = ''; sel.append(o0);
    cams.forEach((d, i) => { if (!d.deviceId) return; const o = el('option', '', d.label || `カメラ ${i + 1}`); o.value = d.deviceId; sel.append(o); });
    sel.value = cams.some(d => d.deviceId === S.camId) ? S.camId : '';
  } catch (e) {}
}

/* 判定ループ：画面が見えているときは描画に合わせ、隠れているときは Worker のタイマーで続ける */
const worker = new Worker(URL.createObjectURL(new Blob(['let t=0;onmessage=e=>{clearTimeout(t);t=setTimeout(()=>postMessage(0),e.data)}'], { type: 'text/javascript' })));
worker.onmessage = () => step();
let scheduled = false;
function schedule() {
  if (!running || scheduled) return; scheduled = true;
  if (document.hidden) worker.postMessage(33); else requestAnimationFrame(() => step());
}
document.addEventListener('visibilitychange', () => { scheduled = false; schedule(); });

const judge = new DETECT.Judge();
let lastR = null, lastVideoTime = -1, lastTs = 0, lastSeen = 0, lastFeat = null, lastPose = null, manual = null;
const sm = { rot: 0, dx: 0, dy: 0, bounce: 0 };
let frames = 0, fpsT = performance.now(), calib = null;
function step() {
  scheduled = false;
  if (!running) return;
  try {
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const ts = Math.max(performance.now(), lastTs + 1); lastTs = ts;
      const res = landmarker.detectForVideo(video, ts);
      onResult(res, ts); frames++;
    }
  } catch (e) { console.error(e); }
  const now = performance.now();
  if (now - fpsT > 1000) { $('#fps').textContent = `${Math.round(frames * 1000 / (now - fpsT))}fps`; frames = 0; fpsT = now; }
  schedule();
}
function onResult(res, now) {
  const bs = res.faceBlendshapes && res.faceBlendshapes[0];
  if (!bs) {
    // 顔が見えないとき：すぐ口を閉じ、1.5秒たったら表情も「通常」に戻す
    const lost = now - lastSeen;
    if (lost > 300) {
      pill('#camStatus', '顔判定：顔が見つかりません', 'ng'); $('#monLabel').textContent = '顔が見つかりません'; $('#monLabel').className = 'lost';
      if (lost > 1500) judge.reset();
      relax(); publish(judge.emotion, 'closed', null); updateGuide(null); drawOverlay(null);
    }
    return;
  }
  lastSeen = now;
  const b = {}; for (const c of bs.categories) b[c.categoryName] = c.score;
  const f = DETECT.features(b, res.faceLandmarks && res.faceLandmarks[0]); lastFeat = f;
  const p = res.faceLandmarks && res.faceLandmarks[0] ? DETECT.pose(res.faceLandmarks[0]) : null; lastPose = p;
  if (calib) { calib.f.push(f); if (p) calib.p.push(p); }
  const sc = DETECT.scores(f, S.base || undefined);
  const r = judge.update(sc, S.thr, now, S.holdMs); lastR = r;
  pill('#camStatus', '顔判定：動作中', 'ok'); $('#monLabel').textContent = `${emoLabel(r.emotion)}・口${mouthLabel(r.mouth)}`; $('#monLabel').className = '';
  updateMeters(sc, r);
  publish(r.emotion, r.mouth, p);
  const lm = res.faceLandmarks && res.faceLandmarks[0];
  updateGuide(r, sc.mouth); drawOverlay(lm, r);
}
function relax() { sm.rot *= 0.9; sm.dx *= 0.9; sm.dy *= 0.9; }
function publish(emotion, mouth, p) {
  if (p) {
    const bp = S.basePose || { roll: 0, yaw: 0, pitch: 0.65 }, k = S.motion, sg = S.mirror ? -1 : 1;
    const clamp = (v, a) => Math.max(-a, Math.min(a, v));
    const rot = clamp(sg * (p.roll - bp.roll) * k, 12);
    const dx = clamp(sg * (p.yaw - bp.yaw) * 500 * k, 200);
    const dy = clamp((p.pitch - bp.pitch) * 300 * k, 80);
    const a = 0.35; sm.rot += (rot - sm.rot) * a; sm.dx += (dx - sm.dx) * a; sm.dy += (dy - sm.dy) * a;
  }
  sm.bounce += ((S.bounce ? (mouth === 'open' ? -14 : mouth === 'half' ? -6 : 0) : 0) - sm.bounce) * 0.5;
  const emo = manual || emotion;
  sendState({ emotion: emo, mouth, rot: sm.rot, dx: sm.dx, dy: sm.dy + sm.bounce });
  const nowEl = $('#now'); nowEl.textContent = `${emoLabel(emo)}・口${mouthLabel(mouth)}${manual ? '（固定）' : ''}`; nowEl.className = 'now' + (manual ? ' manual' : '');
  renderFaceButtons();
}


/* ---------- カメラ横のガイド（顔の動き → 画像の変化） ---------- */
const GUIDE = [
  { id: 'half', act: '口を少し開ける', to: '口「半」', color: '#fdba74' },
  { id: 'mouth', act: '口を大きく開ける', to: '口「開」', color: '#fb923c' },
  { id: 'happy', act: '口角を上げる', to: '喜び', color: '#facc15' },
  { id: 'angry', act: '眉を寄せる・目を細める', to: '怒り', color: '#f87171' },
  { id: 'sad', act: '口角を下げる（への字）', to: '悲しみ', color: '#818cf8' },
  { id: 'troubled', act: '眉頭だけ上げる', to: '困り', color: '#c084fc' },
  { id: 'surprised', act: '眉を上げる・目を見開く', to: '驚き', color: '#38bdf8' },
  { sep: true },
  { id: 'rot', act: '首をかしげる', to: '傾く', color: '#4ade80', pose: true, max: 12 },
  { id: 'dx', act: '顔を左右に向ける', to: '左右に動く', color: '#4ade80', pose: true, max: 200 },
  { id: 'dy', act: 'うなずく・見上げる', to: '上下に動く', color: '#4ade80', pose: true, max: 80 },
];
const gEls = {};
function buildGuide() {
  const box = $('#gRows'); box.textContent = '';
  for (const g of GUIDE) {
    if (g.sep) { box.append(el('div', 'gsep')); continue; }
    const row = el('div', 'grow' + (g.pose ? ' pose' : '')), d = el('span', 'gd'), dot = el('i');
    dot.style.background = g.color; d.append(dot, g.act); d.title = g.act;
    const bar = el('div', 'gb'), fill = el('b'); fill.style.background = g.color; bar.append(fill, el('u'));
    const res = el('span', 'gr', '→ ' + g.to);
    row.append(d, bar, res); box.append(row); gEls[g.id] = { row, fill, res, g };
  }
}
function guideThumb(emotion, mouth) {
  return thumbs.get(imgKey(emotion, mouth)) || thumbs.get(imgKey(emotion, 'closed')) || thumbs.get(imgKey('normal', mouth)) || thumbs.get(imgKey('normal', 'closed')) || '';
}
function updateGuide(r, mouthVal) {
  const on = !!r;
  $('#guide').classList.toggle('off', !on);
  for (const id in gEls) {
    const { row, fill, res, g } = gEls[id];
    if (!g.pose) {
      const v = on ? (id === 'mouth' || id === 'half' ? (mouthVal || 0) / Math.max(S.thr[id], 1e-3) : r.ratios[id]) : 0;   // 1 = しきい値
      fill.style.left = '0'; fill.style.width = Math.min(100, v * 50) + '%';
      const act = on && (id === 'mouth' ? r.mouth === 'open' : id === 'half' ? r.mouth === 'half' : r.emotion === id);
      row.classList.toggle('on', act);
      res.textContent = (act ? '✓ ' : '→ ') + g.to;
    } else {
      const v = Math.max(-1, Math.min(1, (sm[id] || 0) / g.max));
      fill.style.left = (50 + Math.min(0, v) * 50) + '%'; fill.style.width = Math.abs(v) * 50 + '%';
      const act = on && Math.abs(v) > 0.25;
      row.classList.toggle('on', act);
      const dir = id === 'rot' ? (v > 0 ? '右に傾く' : '左に傾く') : id === 'dx' ? (v > 0 ? '右へ動く' : '左へ動く') : (v > 0 ? '下へ動く' : '上へ動く');
      res.textContent = act ? '✓ ' + dir : '→ ' + g.to;
    }
  }
  const emo = manual || state.emotion;
  $('#gNow').textContent = `${emoLabel(emo)}・口${mouthLabel(state.mouth)}${manual ? '（固定）' : ''}`;
  const url = guideThumb(emo, state.mouth), img = $('#gThumb');
  if (url) { if (img.getAttribute('src') !== url) img.src = url; } else img.removeAttribute('src');
}

/* カメラ映像の上に、判定に使っている顔のパーツを色分けして描く */
const LM = {
  lips: [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 61],
  innerLips: [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 78],
  eyeR: [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7, 33],
  eyeL: [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249, 263],
  browR: [46, 53, 52, 65, 55], browL: [276, 283, 282, 295, 285],
  browRin: 55, browLin: 285,
};
const ov = $('#ov'), og = ov.getContext('2d');
function drawOverlay(lm, r) {
  const W = ov.clientWidth, H = ov.clientHeight, dpr = window.devicePixelRatio || 1;
  if (ov.width !== Math.round(W * dpr) || ov.height !== Math.round(H * dpr)) { ov.width = Math.round(W * dpr); ov.height = Math.round(H * dpr); }
  og.setTransform(dpr, 0, 0, dpr, 0, 0); og.clearRect(0, 0, W, H);
  if (!lm || !r) return;
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480, k = Math.max(W / vw, H / vh);
  const ox = (W - vw * k) / 2, oy = (H - vh * k) / 2;
  const P = i => [ox + lm[i].x * vw * k, oy + lm[i].y * vh * k];
  const line = (idx, color, w) => { og.beginPath(); idx.forEach((i, n) => { const [x, y] = P(i); n ? og.lineTo(x, y) : og.moveTo(x, y); }); og.strokeStyle = color; og.lineWidth = w; og.stroke(); };
  const dot = (i, color, rad) => { const [x, y] = P(i); og.beginPath(); og.arc(x, y, rad, 0, 7); og.fillStyle = color; og.fill(); };
  const col = id => GUIDE.find(g => g.id === id).color, dim = 'rgba(255,255,255,.55)';
  const strong = id => r.emotion === id;
  // 眉：怒り・困り・驚きのどれに一番近いかで色を変える
  const browId = ['angry', 'troubled', 'surprised'].reduce((a, b) => (r.ratios[b] > r.ratios[a] ? b : a));
  const browOn = r.ratios[browId] >= 0.5, browCol = browOn ? col(browId) : dim, bw = strong(browId) ? 3 : 2;
  line(LM.browR, browCol, bw); line(LM.browL, browCol, bw);
  if (browId === 'troubled' && browOn) { dot(LM.browRin, browCol, 4); dot(LM.browLin, browCol, 4); }
  // 目：見開き→驚き、細め→怒り
  const eyeCol = r.ratios.surprised >= 0.5 && browId === 'surprised' ? col('surprised') : r.ratios.angry >= 0.5 && browId === 'angry' ? col('angry') : dim;
  line(LM.eyeR, eyeCol, 1.5); line(LM.eyeL, eyeCol, 1.5);
  // 口：開閉と口角
  const mOpen = state.mouth !== 'closed', mc = state.mouth === 'open' ? col('mouth') : col('half');
  line(LM.lips, mOpen ? mc : dim, state.mouth === 'open' ? 3 : mOpen ? 2.2 : 1.5);
  if (mOpen) line(LM.innerLips, mc, 1.5);
  // 口角：上がる→喜び（黄）、下がる→悲しみ（紫）
  const cornerId = r.ratios.happy >= r.ratios.sad ? 'happy' : 'sad', cornerOn = r.ratios[cornerId] >= 0.5;
  const cc = cornerOn ? col(cornerId) : dim, cr = cornerOn ? 5 : 2.5;
  dot(61, cc, cr); dot(291, cc, cr);
  // 頭の傾き：目を結ぶ線（緑）と、水平の基準線（点線）
  const [x1, y1] = P(33), [x2, y2] = P(263), cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, len = Math.hypot(x2 - x1, y2 - y1) * 0.9;
  og.setLineDash([4, 4]); og.beginPath(); og.moveTo(cx - len, cy); og.lineTo(cx + len, cy); og.strokeStyle = 'rgba(255,255,255,.4)'; og.lineWidth = 1; og.stroke(); og.setLineDash([]);
  const a = Math.atan2(y2 - y1, x2 - x1), tilt = Math.abs(sm.rot) / 12 > 0.25;
  og.beginPath(); og.moveTo(cx - Math.cos(a) * len, cy - Math.sin(a) * len); og.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
  og.strokeStyle = tilt ? col('rot') : 'rgba(74,222,128,.45)'; og.lineWidth = tilt ? 2.5 : 1.5; og.stroke();
  dot(1, Math.abs(sm.dx) / 200 > 0.25 || Math.abs(sm.dy) / 80 > 0.25 ? col('dx') : 'rgba(74,222,128,.6)', 4);
}

/* ---------- メーター（判定の強さとしきい値） ---------- */
const METERS = [{ id: 'half', label: '口 半開き', src: 'mouth' }, { id: 'mouth', label: '口 大きく', src: 'mouth' }, { id: 'happy', label: '喜び' }, { id: 'angry', label: '怒り' }, { id: 'sad', label: '悲しみ' }, { id: 'troubled', label: '困り' }, { id: 'surprised', label: '驚き' }];
const SCALE = 0.8;   // メーターの右端の値
const meterEls = {};
function buildMeters() {
  const box = $('#meters'); box.textContent = '';
  for (const m of METERS) {
    const row = el('div', 'mrow'), meter = el('div', 'meter'), bar = el('b'), line = el('i');
    meter.append(bar, line);
    const r = el('input'); Object.assign(r, { type: 'range', min: 0.03, max: SCALE, step: 0.01, title: 'しきい値（左ほど反応しやすい）' });
    r.value = S.thr[m.id];
    const place = () => { line.style.left = `calc(${S.thr[m.id] / SCALE * 100}% - 1px)`; };
    r.oninput = () => { S.thr[m.id] = Number(r.value); place(); save(); };
    r.onchange = () => r.blur();
    place();
    row.append(el('span', 'lb', m.label), meter, r); box.append(row);
    meterEls[m.id] = { row, bar, r, place };
  }
}
function updateMeters(sc, r) {
  for (const m of METERS) {
    const e = meterEls[m.id];
    e.bar.style.width = Math.min(100, sc[m.src || m.id] / SCALE * 100) + '%';
    e.row.classList.toggle('on', m.id === 'mouth' ? r.mouth === 'open' : m.id === 'half' ? r.mouth === 'half' : r.emotion === m.id);
  }
}

/* ---------- いつもの顔を登録 ---------- */
async function calibrate() {
  if (!running) { toast('先に「カメラ開始」を押してください。', true); return; }
  const cd = $('#countdown');
  cd.classList.remove('hide');
  for (const n of [3, 2, 1]) { cd.innerHTML = `${n}<small>正面を向いて、力を抜いた顔をしてください</small>`; await sleep(1000); }
  cd.innerHTML = '記録中…<small>そのまま動かないでください</small>';
  calib = { f: [], p: [] }; window.__app.calibStart = video.currentTime; await sleep(1500);
  const c = calib; calib = null; cd.classList.add('hide');
  if (c.f.length < 3) { toast('顔がうまく見えませんでした。カメラの正面に顔が入るようにして、もう一度押してください。', true); return; }
  const mean = list => { const o = {}; for (const k of Object.keys(list[0])) o[k] = list.reduce((s, x) => s + x[k], 0) / list.length; return o; };
  S.base = mean(c.f); S.basePose = c.p.length ? mean(c.p) : null; save(); judge.reset();
  const B = S.base, odd = B.smile > 0.3 ? '笑顔' : B.jaw > 0.25 ? '口が開いた顔' : B.inner - B.outer > 0.2 ? '眉が上がった顔' : B.browDown > 0.2 ? '眉をひそめた顔' : '';
  window.__app.calibAt = video.currentTime;
  if (odd) toast(`${odd}のまま登録されたようです。力を抜いた真顔で、もう一度「いつもの顔を登録」を押してください。`, true);
  else toast('いつもの顔を登録しました。表情を変えて、メーターの動きを確かめてください。');
}

/* ---------- 表情の固定 ---------- */
function setManual(id) { manual = id; if (!running) publish(id || 'normal', 'closed', null); renderFaceButtons(); updateGuide(running ? lastR : null); }
function renderFaceButtons() {
  const box = $('#faceButtons'); const want = (manual || 'auto');
  if (box.dataset.on === want && box.children.length) return;
  box.dataset.on = want; box.textContent = '';
  const mk = (label, id, key) => { const b = el('button', want === (id || 'auto') ? 'on' : '', label); b.title = `キー ${key}`; b.onclick = () => { setManual(id); b.blur(); }; box.append(b); };
  mk('自動', null, 0);
  EMOTIONS.forEach((e, i) => mk(e.label, e.id, i + 1));
}

/* ---------- 画像 ---------- */
const thumbs = new Map(), dims = new Map();
const MAX_SIDE = 2160;
function setThumb(k, blob) {
  const old = thumbs.get(k); if (old) URL.revokeObjectURL(old);
  if (blob) thumbs.set(k, URL.createObjectURL(blob)); else { thumbs.delete(k); dims.delete(k); }
}
async function measure(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = 48; c.height = 48;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0, 48, 48);
  const d = g.getImageData(0, 0, 48, 48).data; let opaque = true;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { opaque = false; break; }
  const r = { w: bmp.width, h: bmp.height, opaque }; bmp.close(); return r;
}
async function loadThumbs() {
  for (const e of EMOTIONS) for (const m of MOUTHS) {
    const k = imgKey(e.id, m.id), b = await imgGet(k).catch(() => null);
    setThumb(k, b); if (b) { try { dims.set(k, await measure(b)); } catch (err) {} }
  }
}
async function prepareImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch (e) { throw new Error(`「${file.name}」を画像として読み込めません。PNG形式で保存し直してください。`); }
  const sc = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  let blob = file;
  if (sc < 1 || !/^image\/(png|webp|jpeg)$/.test(file.type)) {
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, c.width, c.height);
    blob = await new Promise(r => c.toBlob(r, 'image/png'));
  }
  bmp.close(); return blob;
}
async function storeBlob(k, blob) { await imgPut(k, blob); setThumb(k, blob); dims.set(k, await measure(blob)); }
function imageWarnings() {
  const list = [...dims.entries()];
  const ref = dims.get(imgKey('normal', 'closed')) || (list[0] && list[0][1]);
  const warn = new Map();
  for (const [k, d] of list) {
    const w = [];
    if (d.opaque) w.push('背景が透明ではありません');
    if (ref && Math.abs(d.w / d.h - ref.w / ref.h) > 0.01) w.push('ほかの画像と縦横の比率が違います');
    if (w.length) warn.set(k, w);
  }
  return warn;
}
async function afterImagesChanged(msgs) {
  await stage.loadImages(); ch.postMessage({ type: 'images' }); renderSlots(); updateGuide(running ? lastR : null);
  const warn = imageWarnings();
  if (msgs && warn.size) {
    const kinds = new Set([...warn.values()].flat());
    if (kinds.has('背景が透明ではありません')) toast('背景が透明ではない画像があります。透明背景のPNGで書き出すと、背景色（緑など）だけが映ります。', true);
    else toast('縦横の比率が違う画像があります。18枚とも同じ大きさにすると、表情を変えたときに位置がずれません。', true);
  }
  let persistAsked = afterImagesChanged.asked;
  if (!persistAsked && thumbs.size && navigator.storage && navigator.storage.persist) { afterImagesChanged.asked = true; navigator.storage.persist().catch(() => {}); }
}
async function addFiles(files, slot) {
  files = [...files]; if (!files.length) return;
  let ok = 0; const skipped = [];
  for (const f of files) {
    const s = slot && files.length === 1 ? slot : guessSlot(f.name);
    if (!s) { skipped.push(f.name); continue; }
    try { await storeBlob(imgKey(s.emotion, s.mouth), await prepareImage(f)); ok++; }
    catch (e) { toast(e.message, true); }
  }
  await afterImagesChanged(ok > 0);
  if (skipped.length) toast(`ファイル名から場所を判断できなかった画像があります：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? ' ほか' : ''}。枠に直接ドラッグしてください。`, true);
  else if (ok > 1 && !imageWarnings().size) toast(`${ok}枚の画像を登録しました。`);
}
let pendingSlot = null;
function renderSlots() {
  const box = $('#slots'); box.textContent = '';
  box.append(el('span'), el('span', 'hd', '口を閉じた'), el('span', 'hd', '少し開けた'), el('span', 'hd', '大きく開けた'));
  const warn = imageWarnings();
  for (const e of EMOTIONS) {
    box.append(el('span', 'emo', e.label));
    for (const m of MOUTHS) {
      const k = imgKey(e.id, m.id), url = thumbs.get(k);
      const s = el('div', 'slot' + (url ? ' has' : '')); s.title = `${e.label}（${m.label}）：クリックで選ぶ／ドラッグで登録`;
      if (url) {
        const img = el('img'); img.src = url; img.alt = `${e.label}・${m.label}`; s.append(img);
        const del = el('button', 'del', '✕'); del.title = 'この画像を外す';
        del.onclick = async ev => { ev.stopPropagation(); await imgDel(k); setThumb(k, null); afterImagesChanged(); };
        s.append(del);
        if (warn.has(k)) { s.append(el('span', 'warn', '⚠')); s.title = warn.get(k).join('／'); }
      } else s.append(el('span', 'empty', `${e.label}\n${m.label}`));
      s.onclick = () => { pendingSlot = { emotion: e.id, mouth: m.id }; $('#fileOne').click(); };
      s.ondragover = ev => { ev.preventDefault(); ev.stopPropagation(); s.classList.add('drag'); };
      s.ondragleave = () => s.classList.remove('drag');
      s.ondrop = ev => { ev.preventDefault(); ev.stopPropagation(); s.classList.remove('drag'); $('#imgCard').classList.remove('drag'); addFiles(ev.dataTransfer.files, { emotion: e.id, mouth: m.id }); };
      box.append(s);
    }
  }
  $('#imgCount').textContent = `（${thumbs.size}/${SLOT_COUNT}枚）`;
}
async function loadSample() {
  if (thumbs.size && !confirm('いま登録している画像を、サンプル（魔女）に置き換えます。よろしいですか？')) return;
  try {
    for (const e of EMOTIONS) for (const m of MOUTHS) {
      const r = await fetch(`samples/majo/${e.id}_${m.id}.png?v=20261126`); if (!r.ok) throw new Error('サンプル画像が見つかりません');
      await storeBlob(imgKey(e.id, m.id), await r.blob());
    }
  } catch (err) { toast(err.message, true); }
  afterImagesChanged();
}
const blobToDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
async function exportChar() {
  const images = {};
  for (const e of EMOTIONS) for (const m of MOUTHS) { const b = await imgGet(imgKey(e.id, m.id)); if (b) images[`${e.id}_${m.id}`] = await blobToDataURL(b); }
  if (!Object.keys(images).length) { toast('画像が登録されていません。', true); return; }
  const name = prompt('キャラクターの名前', S.charName || 'キャラクター'); if (name == null) return;
  S.charName = name; save();
  // 「しゃべるキャラクター」と同じ形式（どちらのアプリでも読み込める）
  const data = { app: 'charatalk-chara', version: 1, name, voice: {}, layout: { x: S.x, y: S.y, scale: S.scale }, images };
  const a = el('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = (name.trim() || 'キャラクター').replace(/[\\/:*?"<>|]/g, '_') + '.chara.json'; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function importChar(file) {
  const data = JSON.parse(await file.text());
  if (!data || data.app !== 'charatalk-chara' || !data.images) throw new Error('キャラクターのファイルではありません。');
  if (thumbs.size && !confirm(`いま登録している画像を「${data.name || 'キャラクター'}」に置き換えます。よろしいですか？`)) return;
  for (const e of EMOTIONS) for (const m of MOUTHS) { const k = imgKey(e.id, m.id); await imgDel(k).catch(() => {}); setThumb(k, null); }
  let n = 0;
  for (const [name, url] of Object.entries(data.images)) {
    const [emotion, mouth] = name.split('_');
    if (!EMOTIONS.some(e => e.id === emotion) || !MOUTHS.some(m => m.id === mouth)) continue;
    await storeBlob(imgKey(emotion, mouth), await (await fetch(url)).blob()); n++;
  }
  if (data.layout) { S.x = +data.layout.x || 0; S.y = +data.layout.y || 0; S.scale = +data.layout.scale || 1; }
  S.charName = data.name || S.charName; save(); renderSettings(); sendConfig();
  await afterImagesChanged(true);
  toast(`「${data.name || 'キャラクター'}」を読み込みました（${n}枚）。`);
}

/* ---------- 右側の設定 ---------- */
const shows = [];
function bindRange(id, outId, key, fmt, after) {
  const r = $(id), o = $(outId);
  const show = () => { r.value = S[key]; o.textContent = fmt(Number(r.value)); };
  r.addEventListener('input', () => { S[key] = Number(r.value); o.textContent = fmt(S[key]); if (after) after(); save(); });
  r.addEventListener('change', () => r.blur());
  shows.push(show);
}
function renderSettings() {
  shows.forEach(f => f());
  for (const b of $('#bgButtons').children) b.classList.toggle('on', b.dataset.bg === S.bg);
  $('#chkBounce').checked = S.bounce; $('#chkMirror').checked = S.mirror; $('#chkMonitor').checked = S.monitor;
  $('#monitor').classList.toggle('hide', !S.monitor); $('#monitor').classList.toggle('mirror', S.mirror);
  for (const m of METERS) if (meterEls[m.id]) { meterEls[m.id].r.value = S.thr[m.id]; meterEls[m.id].place(); }
}
function togglePanel() {
  document.body.classList.toggle('nopanel');
  $('#btnPanel').textContent = document.body.classList.contains('nopanel') ? '設定を出す' : '設定を隠す';
}
function bind() {
  const sgn = n => (n > 0 ? '+' : '') + n;
  bindRange('#rngX', '#outX', 'x', sgn, sendConfig);
  bindRange('#rngY', '#outY', 'y', sgn, sendConfig);
  bindRange('#rngScale', '#outScale', 'scale', n => Math.round(n * 100) + '%', sendConfig);
  bindRange('#rngMotion', '#outMotion', 'motion', n => Math.round(n * 100) + '%');
  bindRange('#rngHold', '#outHold', 'holdMs', n => (n / 1000).toFixed(2) + '秒');
  for (const b of $('#bgButtons').children) b.onclick = () => { S.bg = b.dataset.bg; renderSettings(); sendConfig(); save(); b.blur(); };
  $('#chkBounce').onchange = e => { S.bounce = e.target.checked; save(); e.target.blur(); };
  $('#chkMirror').onchange = e => { S.mirror = e.target.checked; renderSettings(); save(); e.target.blur(); };
  $('#chkMonitor').onchange = e => { S.monitor = e.target.checked; renderSettings(); save(); e.target.blur(); };
  $('#btnResetLayout').onclick = e => { Object.assign(S, { x: 0, y: 0, scale: 1 }); renderSettings(); sendConfig(); save(); e.target.blur(); };
  $('#btnResetDetect').onclick = e => {
    e.target.blur(); if (!confirm('しきい値・切り替えの間・登録した「いつもの顔」を初めの状態に戻します。よろしいですか？')) return;
    S.thr = { ...DETECT.DEFAULT_THR }; S.base = null; S.basePose = null; S.holdMs = DEFAULTS.holdMs; judge.reset(); renderSettings(); save();
  };
  $('#btnCalib').onclick = e => { e.target.blur(); calibrate(); };
  $('#btnCam').onclick = e => { e.target.blur(); running ? stopCamera() : startCamera(); };
  $('#selCam').onchange = e => { S.camId = e.target.value; save(); e.target.blur(); if (running) startCamera(); };
  $('#btnPanel').onclick = e => { e.target.blur(); togglePanel(); };
  $('#btnFull').onclick = e => { e.target.blur(); $('#stageWrap').requestFullscreen().catch(() => {}); };
  $('#btnOpenStage').onclick = e => {
    e.target.blur();
    const w = window.open('stage.html', 'kaochara-stage', 'popup,width=1280,height=720');
    if (!w) toast('出力画面を開けませんでした。ブラウザのポップアップ許可を確認してください。', true);
    else toast('出力画面を ATEM 側のディスプレイへ移動し、ダブルクリックで全画面にしてください。この画面は最小化しないでください。');
  };
  // 画像
  $('#btnBulk').onclick = e => { $('#fileBulk').click(); e.target.blur(); };
  $('#fileBulk').onchange = e => { const f = [...e.target.files]; e.target.value = ''; addFiles(f, null); };
  $('#fileOne').onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (pendingSlot) addFiles(f, pendingSlot); pendingSlot = null; };
  const card = $('#imgCard');
  card.ondragover = e => { e.preventDefault(); card.classList.add('drag'); };
  card.ondragleave = e => { if (!card.contains(e.relatedTarget)) card.classList.remove('drag'); };
  card.ondrop = e => { e.preventDefault(); card.classList.remove('drag'); addFiles(e.dataTransfer.files, null); };
  $('#btnSample').onclick = e => { e.target.blur(); loadSample(); };
  $('#btnExport').onclick = e => { e.target.blur(); exportChar().catch(err => toast('書き出せませんでした：' + err.message, true)); };
  $('#btnImport').onclick = e => { e.target.blur(); $('#fileImport').click(); };
  $('#fileImport').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importChar(f).catch(err => toast('読み込めませんでした：' + err.message, true)); };
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());
  // キーボード
  document.addEventListener('keydown', e => {
    const t = e.target, tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '0') setManual(null);
    else if (/^[1-6]$/.test(e.key)) setManual(EMOTIONS[Number(e.key) - 1].id);
    else if (e.key === 'h' || e.key === 'H') togglePanel();
    else if (e.key === 'm' || e.key === 'M') { S.monitor = !S.monitor; renderSettings(); save(); }
    else if (e.key === 'f' || e.key === 'F') $('#stageWrap').requestFullscreen().catch(() => {});
  });
}

/* ---------- 起動 ---------- */
async function init() {
  buildMeters(); buildGuide(); bind(); renderSettings(); renderFaceButtons(); sendConfig();
  ch.postMessage({ type: 'who' });
  try { await loadThumbs(); } catch (e) { toast('画像の保存領域を使えません（シークレットウィンドウでは使えないことがあります）。', true); }
  renderSlots(); await stage.loadImages(); updateGuide(null);
  publish('normal', 'closed', null);
  // css/app.css が古いままだとガイドが崩れるので知らせる（ブラウザのキャッシュ・アップロード漏れ）
  if (!getComputedStyle(document.documentElement).getPropertyValue('--kaochara-css').includes('20261126'))
    toast('css/app.css が古いままです。GitHub に最新の css フォルダをアップロードし、Shift を押しながら再読み込みしてください。', true);
  try { await initModel(); }
  catch (e) { console.error(e); pill('#camStatus', '顔判定：読み込み失敗', 'ng'); toast('顔判定の準備に失敗しました。ページを再読み込みしてください：' + e.message, true); }
}
// ページを閉じる・再読み込みするときは、カメラと顔判定を止めてメモリを返す
window.addEventListener('pagehide', () => { stopCamera(); try { landmarker && landmarker.close(); } catch (e) {} });
window.__app = { get S() { return S; }, judge, get state() { return state; }, get feat() { return lastFeat; }, get pose() { return lastPose; }, get sm() { return sm; }, startCamera, stopCamera, calibrate };
init();
