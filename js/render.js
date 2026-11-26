'use strict';
/* キャラクターの描画（操作画面のプレビューと出力画面で共通）。1920×1080 のキャンバスに描く。 */
class Stage {
  constructor(canvas, { hint = false } = {}) {
    this.cv = canvas; this.g = canvas.getContext('2d'); this.W = canvas.width; this.H = canvas.height;
    this.hint = hint; this.bitmaps = new Map(); this.loadSeq = 0; this.dirty = true;
    this.config = { bg: '#00ff00', x: 0, y: 0, scale: 1 };
    this.state = { emotion: 'normal', mouth: 'closed', rot: 0, dx: 0, dy: 0 };
    this.log = [];
    const tick = () => { if (this.dirty) { this.dirty = false; this.draw(); } requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
  async loadImages() {
    const seq = ++this.loadSeq, got = new Map();
    for (const e of EMOTIONS) for (const m of MOUTHS) {
      const k = imgKey(e.id, m.id);
      try { const b = await imgGet(k); if (b) got.set(k, await createImageBitmap(b)); } catch (err) { console.error(err); }
    }
    if (seq !== this.loadSeq) return;
    for (const v of this.bitmaps.values()) if (![...got.values()].includes(v)) v.close();
    this.bitmaps = got; this.dirty = true;
  }
  get count() { return this.bitmaps.size; }
  setConfig(c) { this.config = { ...this.config, ...c }; this.dirty = true; }
  setState(s) {
    const o = this.state;
    if (s.emotion !== o.emotion || s.mouth !== o.mouth) { if (this.log.length < 5000) this.log.push({ t: Date.now(), emotion: s.emotion, mouth: s.mouth }); }
    this.state = { ...o, ...s }; this.dirty = true;
  }
  pick() {
    const { emotion, mouth } = this.state, b = this.bitmaps;
    const alt = mouth === 'half' ? 'open' : mouth === 'open' ? 'half' : 'closed';
    return b.get(imgKey(emotion, mouth)) || b.get(imgKey(emotion, alt)) || b.get(imgKey(emotion, 'closed')) || b.get(imgKey('normal', mouth)) || b.get(imgKey('normal', 'closed')) || null;
  }
  draw() {
    const { g, W, H, config: c, state: s } = this;
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (c.bg === 'transparent') g.clearRect(0, 0, W, H); else { g.fillStyle = c.bg; g.fillRect(0, 0, W, H); }
    const bmp = this.pick();
    if (!bmp) {
      if (this.hint) {
        g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(W / 2 - 720, H / 2 - 70, 1440, 140);
        g.fillStyle = '#fff'; g.font = '52px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('右の「キャラクター画像」に画像を登録してください', W / 2, H / 2);
      }
      return;
    }
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    const h = H * (c.scale || 1), w = h * bmp.width / bmp.height;
    const rot = (s.rot || 0) * Math.PI / 180;
    // 傾けたときに画像の下の端が画面の中に見えないよう、傾きの分だけ少し沈める
    const sink = (c.y || 0) <= 0 ? Math.abs(Math.sin(rot)) * w / 2 : 0;
    g.translate(W / 2 + (c.x || 0) + (s.dx || 0), H - (c.y || 0) + (s.dy || 0) + sink);
    g.rotate(rot);
    g.drawImage(bmp, -w / 2, -h, w, h);
    // 頭を動かして画像が持ち上がっても下に隙間ができないよう、画像のいちばん下の行を下へ引き伸ばす
    if ((c.y || 0) <= 0) g.drawImage(bmp, 0, bmp.height - 1, bmp.width, 1, -w / 2, -0.5, w, 400);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
}
