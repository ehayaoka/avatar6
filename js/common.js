'use strict';
/* 表情の定義と、画像の保存（ブラウザ内の IndexedDB）。画像はサーバーには送られない。 */
const CHANNEL = 'kaochara-v1';
const EMOTIONS = [
  { id: 'normal',    label: '通常', keys: ['normal', 'nomal', 'neutral', 'futsu', 'futuu', '通常', 'ふつう', '普通'] },
  { id: 'happy',     label: '喜び', keys: ['happy', 'joy', 'smile', 'yorokobi', '喜び', '喜', 'よろこび', '笑顔'] },
  { id: 'angry',     label: '怒り', keys: ['angry', 'anger', 'mad', 'ikari', '怒り', '怒', 'いかり'] },
  { id: 'sad',       label: '悲しみ', keys: ['sad', 'sorrow', 'kanashimi', '悲しみ', '悲', 'かなしみ', '哀'] },
  { id: 'troubled',  label: '困り', keys: ['troubled', 'trouble', 'worried', 'komari', '困り', '困', 'こまり'] },
  { id: 'surprised', label: '驚き', keys: ['surprised', 'surprise', 'odoroki', '驚き', '驚', 'おどろき'] },
];
const MOUTHS = [
  { id: 'closed', label: '閉', keys: ['closed', 'close', 'shut', 'toji', '閉', 'とじ'] },
  { id: 'half',   label: '半', keys: ['half', 'hanbiraki', '半', 'はんびらき'] },
  { id: 'open',   label: '開', keys: ['open', 'hiraki', 'aki', '開', 'ひらき', 'あき'] },
];
const mouthLabel = id => (MOUTHS.find(m => m.id === id) || MOUTHS[0]).label;
const SLOT_COUNT = 18;   // 6感情 × 口3段階
const emoLabel = id => (EMOTIONS.find(e => e.id === id) || EMOTIONS[0]).label;
const imgKey = (emotion, mouth) => `${emotion}/${mouth}`;

/* ファイル名から「どの表情・どの口か」を推測する（例：happy_open.png、喜び_開.png） */
function guessSlot(fileName) {
  const n = fileName.normalize('NFC').toLowerCase().replace(/\.[a-z0-9]+$/, '');
  const hit = list => { const f = list.filter(x => x.keys.some(k => n.includes(k))); return f.length === 1 ? f[0].id : null; };
  const emotion = hit(EMOTIONS);
  // 「半開き」「half_open」は「開」も含むので、「半」を先に見る
  const mouth = MOUTHS[1].keys.some(k => n.includes(k)) ? 'half' : hit(MOUTHS);
  return emotion && mouth ? { emotion, mouth } : null;
}

let dbPromise = null;
function db() {
  if (!dbPromise) dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open('kaochara', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('images');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('ブラウザの保存領域を開けません'));
  });
  return dbPromise;
}
async function idbReq(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('images', mode), req = fn(tx.objectStore('images'));
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = tx.onabort = () => rej(tx.error || new Error('保存に失敗しました'));
  });
}
const imgGet = key => idbReq('readonly', s => s.get(key));
const imgPut = (key, blob) => idbReq('readwrite', s => s.put(blob, key));
const imgDel = key => idbReq('readwrite', s => s.delete(key));
