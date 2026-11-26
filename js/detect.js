'use strict';
/* 顔の動き（MediaPipe の blendshape 0〜1）から、6つの表情と口の3段階（閉・半・開）を判定する。
   人によって「いつもの顔」の値が違うため、基準値（キャリブレーション）を引いてから計算する。 */
const DETECT = (() => {
  const DEFAULT_BASE = { smile: 0.01, jaw: 0.02, browDown: 0.01, inner: 0.12, outer: 0.10, squint: 0.15, wide: 0.02, frown: 0.0, shrug: 0.1 };
  const DEFAULT_THR = { half: 0.05, mouth: 0.25, happy: 0.35, angry: 0.22, sad: 0.22, troubled: 0.22, surprised: 0.35 };
  const avg = (b, l, r) => ((b[l] || 0) + (b[r] || 0)) / 2;

  /* blendshape の一覧（{名前: 値}）から、判定に使う特徴量をまとめる */
  function features(b, lm) {
    // 唇のすき間（上唇の内側〜下唇の内側）を目尻の間の長さで割った値。少しだけ開いた口は jawOpen より正確にとれる
    let gap = 0;
    if (lm && lm[13] && lm[14] && lm[33] && lm[263]) gap = Math.hypot(lm[13].x - lm[14].x, lm[13].y - lm[14].y) / (Math.hypot(lm[33].x - lm[263].x, lm[33].y - lm[263].y) || 1);
    return {
      gap,
      smile: avg(b, 'mouthSmileLeft', 'mouthSmileRight'),
      jaw: b.jawOpen || 0,
      browDown: avg(b, 'browDownLeft', 'browDownRight'),
      inner: b.browInnerUp || 0,
      outer: avg(b, 'browOuterUpLeft', 'browOuterUpRight'),
      squint: avg(b, 'eyeSquintLeft', 'eyeSquintRight'),
      wide: avg(b, 'eyeWideLeft', 'eyeWideRight'),
      frown: avg(b, 'mouthFrownLeft', 'mouthFrownRight'),
      shrug: b.mouthShrugLower || 0,
    };
  }
  /* 特徴量 → 各表情の強さ */
  function scores(f, base) {
    base = base || DEFAULT_BASE;
    const d = k => Math.max(0, (f[k] || 0) - (base[k] ?? DEFAULT_BASE[k] ?? 0));
    const innerOnly = Math.max(0, d('inner') - 1.3 * d('outer') - d('wide'));
    const notSmiling = Math.max(0, 1 - 1.5 * f.smile);
    return {
      mouth: Math.max(d('jaw'), 1.5 * (f.gap || 0)),
      happy: d('smile'),
      // 怒り：眉が下がる・目を細める・眉頭がいつもより下がる（笑顔のときは除く）
      angry: (1.5 * d('browDown') + 0.6 * d('squint') + Math.min(0.1, 0.6 * Math.max(0, (base.inner ?? 0) - f.inner))) * notSmiling,
      // 悲しみ：口角が下がる・下唇を押し上げる（口がへの字）。眉頭が上がると強くなる
      sad: (1.6 * d('frown') + 0.6 * d('shrug') + 0.3 * innerOnly) * notSmiling,
      // 困り：眉頭だけが上がる（眉全体が上がる「驚き」、口がへの字の「悲しみ」とはここで区別する）
      troubled: Math.max(0, innerOnly - 0.8 * d('frown') - 0.5 * d('shrug')),
      // 驚き：眉全体が上がる・目を見開く
      surprised: 0.7 * d('outer') + 0.6 * d('wide'),
    };
  }
  /* ちらつかないように、少しのあいだ続いたときだけ表情を切り替える */
  class Judge {
    constructor() { this.emotion = 'normal'; this.mouth = 'closed'; this.cand = null; this.since = 0; }
    update(sc, thr, now, holdMs) {
      const names = ['happy', 'angry', 'sad', 'troubled', 'surprised'];
      const r = {}; for (const n of names) r[n] = sc[n] / Math.max(thr[n], 1e-3);
      let best = names[0]; for (const n of names) if (r[n] > r[best]) best = n;
      let target = r[best] >= 1 ? best : 'normal';
      const cur = this.emotion;
      // いまの表情は、しきい値の75%を下回るまで保つ（ほかの表情がはっきり強いときは切り替える）
      if (cur !== 'normal' && r[cur] >= 0.75 && (target === 'normal' || r[target] < r[cur] * 1.25)) target = cur;
      if (target !== cur) {
        if (this.cand !== target) { this.cand = target; this.since = now; }
        if (now - this.since >= holdMs) { this.emotion = target; this.cand = null; }
      } else this.cand = null;
      // 口：3段階。いまの段階は、しきい値の75%を下回るまで保つ（ぱくぱくのちらつき防止）
      const mo = sc.mouth / Math.max(thr.mouth, 1e-3), mh = sc.mouth / Math.max(Math.min(thr.half, thr.mouth * 0.95), 1e-3);
      const lv = { closed: 0, half: 1, open: 2 }[this.mouth];
      let nl = mo >= 1 ? 2 : mh >= 1 ? 1 : 0;
      if (nl < lv) { if (lv === 2 && mo >= 0.75) nl = 2; else if (lv >= 1 && mh >= 0.75) nl = Math.max(nl, 1); }
      this.mouth = ['closed', 'half', 'open'][nl];
      return { emotion: this.emotion, mouth: this.mouth, ratios: r };
    }
    reset() { this.emotion = 'normal'; this.mouth = 'closed'; this.cand = null; }
  }
  /* 顔の点（478点）から、頭の傾き・左右の向き・上下の向きを求める */
  function pose(lm) {
    const L = lm[33], R = lm[263], N = lm[1];
    if (!L || !R || !N) return null;
    const ex = R.x - L.x, ey = R.y - L.y, ed = Math.hypot(ex, ey) || 1e-3;
    const mx = (L.x + R.x) / 2, my = (L.y + R.y) / 2;
    const nx = ((N.x - mx) * ex + (N.y - my) * ey) / ed / ed;
    const ny = (-(N.x - mx) * ey + (N.y - my) * ex) / ed / ed;
    return { roll: Math.atan2(ey, ex) * 180 / Math.PI, yaw: nx, pitch: ny };
  }
  return { DEFAULT_BASE, DEFAULT_THR, features, scores, Judge, pose };
})();
if (typeof module !== 'undefined') module.exports = DETECT;
