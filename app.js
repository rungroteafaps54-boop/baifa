'use strict';
/* ===== ตัวช่วยทั่วไป ===== */
const $ = s => document.querySelector(s);
const LS = {
  get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} }
};
const cfg = {
  get clientId() { return (LS.get('clientId') || window.APP_CONFIG?.clientId || '').trim(); },
  get root() { return (LS.get('rootFolder') || window.APP_CONFIG?.rootFolder || 'ใบฟ้า').trim(); }
};
const REDIRECT = location.origin + location.pathname.replace(/index\.html$/, '');
const SCOPES = ['Files.ReadWrite'];
const FONT = '"Sarabun","Noto Sans Thai",sans-serif';

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  kids.forEach(k => e.append(k));
  return e;
}
function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = Math.round(w); c.height = Math.round(h); return c; }
let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
// ตัดอักขระที่ OneDrive/Windows ไม่ยอมให้ใช้ในชื่อไฟล์
function safeName(s) { return String(s).replace(/[\\/:*?"<>|#%\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, ''); }
function thaiDateStamp(d) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear() + 543}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function makeNames(caseNo, rcpt, track, d) {
  const parts = ['ใบฟ้า', safeName(caseNo), safeName(rcpt)];
  if (track.trim()) parts.push(safeName(track));
  parts.push(thaiDateStamp(d));
  return { fileName: parts.join('_') + '.pdf', folder: `${safeName(cfg.root)}/${safeName(caseNo)}` };
}

/* ===== ฐานข้อมูลในเครื่อง (ทะเบียน + คิวอัปโหลด) ===== */
let dbp;
function db() {
  return dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('baifa', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('records', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('records', mode); const rq = fn(t.objectStore('records'));
    t.oncomplete = () => res(rq?.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
const dbPut = r => tx('readwrite', s => s.put(r));
const dbAll = () => tx('readonly', s => s.getAll());
const dbDel = id => tx('readwrite', s => s.delete(id));

/* ===== ประมวลผลภาพ ===== */
const fullCorners = c => [{ x: 0, y: 0 }, { x: c.width, y: 0 }, { x: c.width, y: c.height }, { x: 0, y: c.height }];
const isFull = (c, q) => q.every((p, i) => { const f = fullCorners(c)[i]; return Math.abs(p.x - f.x) < 2 && Math.abs(p.y - f.y) < 2; });

// หาขอบใบฟ้า: ใบฟ้าเป็นสีฟ้าอ่อน (น้ำเงิน > แดง และสว่าง) ต่างจากพื้นโต๊ะ/กระดาษขาว
function detectCorners(src) {
  const s = 320 / Math.max(src.width, src.height);
  const w = Math.round(src.width * s), h = Math.round(src.height * s);
  const c = mkCanvas(w, h); const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  // ค่า "ความฟ้า" (น้ำเงิน − แดง) ของจุดที่สว่างพอ แล้วหาเส้นแบ่งที่แยกใบฟ้ากับพื้นหลังได้ดีที่สุด (Otsu)
  const N = w * h, v = new Int16Array(N), hist = new Float64Array(256);
  let cnt = 0;
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    if (d[p] + d[p + 1] + d[p + 2] < 300) { v[i] = -999; continue; }
    v[i] = Math.max(-128, Math.min(127, d[p + 2] - d[p]));
    hist[v[i] + 128]++; cnt++;
  }
  if (cnt < N * 0.1) return null;
  let sumAll = 0; for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, best = 0, thr = 0, sep = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = cnt - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = i - 128; sep = mF - mB; }
  }
  if (sep < 12) return null;
  const m = new Uint8Array(N);
  for (let i = 0; i < N; i++) m[i] = v[i] > thr ? 1 : 0;
  // เก็บเฉพาะก้อนสีฟ้าที่ใหญ่ที่สุด (กันวัตถุอื่นในภาพ)
  const lab = new Int32Array(N), stack = new Int32Array(N);
  let bestLab = 0, n = 0, cur = 0;
  for (let s0 = 0; s0 < N; s0++) {
    if (!m[s0] || lab[s0]) continue;
    cur++; let sp = 0, size = 0; stack[sp++] = s0; lab[s0] = cur;
    while (sp) {
      const i = stack[--sp], x = i % w; size++;
      if (x > 0 && m[i - 1] && !lab[i - 1]) { lab[i - 1] = cur; stack[sp++] = i - 1; }
      if (x < w - 1 && m[i + 1] && !lab[i + 1]) { lab[i + 1] = cur; stack[sp++] = i + 1; }
      if (i >= w && m[i - w] && !lab[i - w]) { lab[i - w] = cur; stack[sp++] = i - w; }
      if (i < N - w && m[i + w] && !lab[i + w]) { lab[i + w] = cur; stack[sp++] = i + w; }
    }
    if (size > n) { n = size; bestLab = cur; }
  }
  let tl, tr, br, bl, vTl = 1e9, vTr = -1e9, vBr = -1e9, vBl = 1e9;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (lab[y * w + x] !== bestLab) continue;
    if (x + y < vTl) { vTl = x + y; tl = { x, y }; }
    if (x + y > vBr) { vBr = x + y; br = { x, y }; }
    if (x - y > vTr) { vTr = x - y; tr = { x, y }; }
    if (x - y < vBl) { vBl = x - y; bl = { x, y }; }
  }
  if (n < N * 0.04 || n > N * 0.92) return null;
  const q = [tl, tr, br, bl];
  let area = 0;
  for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; area += a.x * b.y - b.x * a.y; }
  if (Math.abs(area) / 2 < w * h * 0.05) return null;
  // ขยายออกเล็กน้อยให้เห็นขอบใบครบ
  const cx = (tl.x + tr.x + br.x + bl.x) / 4, cy = (tl.y + tr.y + br.y + bl.y) / 4;
  return q.map(p => ({
    x: Math.min(src.width, Math.max(0, (cx + (p.x - cx) * 1.012) / s)),
    y: Math.min(src.height, Math.max(0, (cy + (p.y - cy) * 1.012) / s))
  }));
}

// ดัดภาพจากสี่เหลี่ยมมุมเอียง (q: ซ้ายบน ขวาบน ขวาล่าง ซ้ายล่าง) ให้เป็นสี่เหลี่ยมตรง
function warp(src, q) {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  let W = Math.max(dist(q[0], q[1]), dist(q[3], q[2])), H = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const k = Math.min(1, 1800 / Math.max(W, H)); W = Math.max(8, Math.round(W * k)); H = Math.max(8, Math.round(H * k));
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, sx = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, sy = p0.y - p1.y + p2.y - p3.y;
  const den = dx1 * dy2 - dx2 * dy1;
  let g = 0, hh = 0;
  if (Math.abs(den) > 1e-9 && (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9)) { g = (sx * dy2 - dx2 * sy) / den; hh = (dx1 * sy - sx * dy1) / den; }
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + hh * p3.x, c = p0.x;
  const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + hh * p3.y, f = p0.y;
  const sw = src.width, sh = src.height;
  const sd = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
  const out = mkCanvas(W, H), og = out.getContext('2d'), od = og.createImageData(W, H), o = od.data;
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1), z = g * u + hh * v + 1;
      let fx = (a * u + b * v + c) / z, fy = (d * u + e * v + f) / z;
      fx = Math.min(sw - 1.001, Math.max(0, fx)); fy = Math.min(sh - 1.001, Math.max(0, fy));
      const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4, oi = (y * W + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        o[oi + ch] = (sd[i00 + ch] * (1 - tx) + sd[i10 + ch] * tx) * (1 - ty) + (sd[i01 + ch] * (1 - tx) + sd[i11 + ch] * tx) * ty;
      }
      o[oi + 3] = 255;
    }
  }
  og.putImageData(od, 0, 0);
  return out;
}

// ยืดระดับสว่าง–มืดให้ตัวหนังสือ ลายมือชื่อ และตราประทับชัดขึ้น (คงสีฟ้าของใบไว้)
function enhance(cv) {
  const g = cv.getContext('2d', { willReadFrequently: true }), im = g.getImageData(0, 0, cv.width, cv.height), d = im.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 16) hist[(d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10 | 0]++;
  const total = d.length / 16; let lo = 0, hi = 255, acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > total * 0.01) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > total * 0.02) { hi = i; break; } }
  if (hi - lo < 40) return;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = (i - lo) * 255 / (hi - lo);
  for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
  g.putImageData(im, 0, 0);
}

function processItem(it) {
  if (isFull(it.src, it.corners)) {
    it.out = mkCanvas(it.src.width, it.src.height); it.out.getContext('2d').drawImage(it.src, 0, 0);
  } else it.out = warp(it.src, it.corners);
  if (it.enhance) enhance(it.out);
}

/* ===== หน้าเก็บใบฟ้า ===== */
let items = [];
async function addFiles(files) {
  for (const f of files) {
    try {
      let bmp;
      try { bmp = await createImageBitmap(f, { imageOrientation: 'from-image' }); } catch { bmp = await createImageBitmap(f); }
      const k = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
      const src = mkCanvas(bmp.width * k, bmp.height * k);
      src.getContext('2d').drawImage(bmp, 0, 0, src.width, src.height);
      bmp.close?.();
      const it = { src, corners: detectCorners(src) || fullCorners(src), enhance: true };
      processItem(it); items.push(it);
    } catch (e) { toast('เปิดรูปไม่ได้: ' + (f.name || '')); }
  }
  renderThumbs();
}
function renderThumbs() {
  const box = $('#thumbs'); box.replaceChildren();
  items.forEach((it, i) => {
    const k = 360 / it.out.width, t = mkCanvas(360, it.out.height * k);
    t.getContext('2d').drawImage(it.out, 0, 0, t.width, t.height);
    box.append(el('div', { className: 'thumb' }, t,
      el('div', { className: 'cap', textContent: `ภาพที่ ${i + 1}` }),
      el('div', { className: 'row' },
        el('button', { className: 'small', textContent: 'ปรับ', onclick: () => openEditor(it) }),
        el('button', { className: 'small danger', textContent: 'ลบ', onclick: () => { items.splice(i, 1); renderThumbs(); } }))));
  });
}
function renderFileName() {
  const c = $('#f-case').value.trim(), r = $('#f-rcpt').value.trim();
  $('#fname').textContent = (c && r)
    ? (() => { const n = makeNames(c, r, $('#f-track').value, new Date()); return `บันทึกเป็น: OneDrive/${n.folder}/${n.fileName}`; })()
    : 'กรอกเลขคดีและชื่อผู้รับเพื่อดูชื่อไฟล์';
}

/* ===== ตัวปรับมุม ===== */
let ed = null;
function openEditor(it) {
  ed = { it, corners: it.corners.map(p => ({ ...p })), drag: -1 };
  $('#ed-enh').checked = it.enhance; $('#editor').hidden = false; drawEditor();
}
function drawEditor() {
  const cv = $('#ed-canvas'), wrap = $('#ed-wrap'), src = ed.it.src, dpr = window.devicePixelRatio || 1;
  const s = Math.min((wrap.clientWidth - 40) / src.width, (wrap.clientHeight - 40) / src.height);
  ed.s = s; ed.pad = 20;
  const cw = src.width * s + 40, ch = src.height * s + 40;
  cv.style.width = cw + 'px'; cv.style.height = ch + 'px'; cv.width = cw * dpr; cv.height = ch * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cw, ch); g.drawImage(src, 20, 20, src.width * s, src.height * s);
  const P = ed.corners.map(p => ({ x: p.x * s + 20, y: p.y * s + 20 }));
  g.beginPath(); P.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.closePath();
  g.lineWidth = 2.5; g.strokeStyle = '#ff9800'; g.stroke(); g.fillStyle = 'rgba(255,152,0,.12)'; g.fill();
  P.forEach(p => { g.beginPath(); g.arc(p.x, p.y, 13, 0, 7); g.fillStyle = 'rgba(255,152,0,.85)'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke(); });
}
function edPoint(ev) { const r = $('#ed-canvas').getBoundingClientRect(); return { x: (ev.clientX - r.left - ed.pad) / ed.s, y: (ev.clientY - r.top - ed.pad) / ed.s }; }
function initEditor() {
  const cv = $('#ed-canvas');
  cv.addEventListener('pointerdown', ev => {
    const p = edPoint(ev); let best = -1, bd = 1e9;
    ed.corners.forEach((c, i) => { const d = Math.hypot(c.x - p.x, c.y - p.y); if (d < bd) { bd = d; best = i; } });
    ed.drag = best; cv.setPointerCapture(ev.pointerId);
  });
  cv.addEventListener('pointermove', ev => {
    if (!ed || ed.drag < 0) return;
    const p = edPoint(ev), src = ed.it.src;
    ed.corners[ed.drag] = { x: Math.min(src.width, Math.max(0, p.x)), y: Math.min(src.height, Math.max(0, p.y)) };
    drawEditor();
  });
  const end = () => { if (ed) ed.drag = -1; };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  $('#ed-rot').onclick = () => {
    const s = ed.it.src, r = mkCanvas(s.height, s.width), g = r.getContext('2d');
    g.translate(r.width, 0); g.rotate(Math.PI / 2); g.drawImage(s, 0, 0);
    ed.it.src = r; ed.corners = detectCorners(r) || fullCorners(r); drawEditor();
  };
  $('#ed-auto').onclick = () => { const q = detectCorners(ed.it.src); if (q) ed.corners = q; else toast('หาขอบไม่พบ กรุณาลากมุมเอง'); drawEditor(); };
  $('#ed-full').onclick = () => { ed.corners = fullCorners(ed.it.src); drawEditor(); };
  const close = () => { $('#editor').hidden = true; ed = null; renderThumbs(); };
  $('#ed-cancel').onclick = () => { processItem(ed.it); close(); }; // เผื่อมีการหมุนภาพไปแล้ว
  $('#ed-ok').onclick = () => { ed.it.corners = ed.corners; ed.it.enhance = $('#ed-enh').checked; processItem(ed.it); close(); };
  window.addEventListener('resize', () => ed && drawEditor());
}

/* ===== สร้างหน้า A4 และไฟล์ PDF ===== */
const PW = 1654, PH = 2339, MG = 100; // A4 ที่ 200 จุดต่อนิ้ว
function buildPages(list, meta, per) {
  const pages = [], cols = per === 4 ? 2 : 1, rows = Math.ceil(per / cols), nPages = Math.ceil(list.length / per);
  for (let i = 0; i < list.length; i += per) {
    const c = mkCanvas(PW, PH), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, PW, PH);
    g.fillStyle = '#000'; g.textBaseline = 'top';
    g.font = 'bold 46px ' + FONT; g.fillText('สำเนาไปรษณีย์ตอบรับ (ใบฟ้า)', MG, MG);
    g.font = '34px ' + FONT;
    let line = `คดีที่ ${meta.caseNo}   ผู้รับ ${meta.recipient}`;
    if (meta.tracking) line += `   เลขพัสดุ ${meta.tracking}`;
    g.fillText(line, MG, MG + 68, PW - 2 * MG);
    const top = MG + 140, gap = 36, capH = 54;
    const slotW = (PW - 2 * MG - (cols - 1) * gap) / cols, slotH = (PH - top - MG - 50 - (rows - 1) * gap) / rows;
    list.slice(i, i + per).forEach((it, k) => {
      const x = MG + (k % cols) * (slotW + gap), y = top + Math.floor(k / cols) * (slotH + gap);
      const s = Math.min(slotW / it.out.width, (slotH - capH) / it.out.height);
      const w = it.out.width * s, h = it.out.height * s, ix = x + (slotW - w) / 2;
      g.imageSmoothingQuality = 'high'; g.drawImage(it.out, ix, y, w, h);
      g.strokeStyle = '#888'; g.lineWidth = 1.5; g.strokeRect(ix, y, w, h);
      g.font = '28px ' + FONT; g.fillStyle = '#333'; g.fillText(`ภาพที่ ${i + k + 1} จาก ${list.length}`, ix, y + h + 10);
    });
    g.font = '26px ' + FONT; g.fillStyle = '#555'; g.textAlign = 'right';
    g.fillText(`บันทึกเมื่อ ${meta.dateText}   หน้า ${pages.length + 1}/${nPages}`, PW - MG, PH - MG - 10);
    g.textAlign = 'left';
    pages.push(c);
  }
  return pages;
}
async function makePdf(pages) {
  const enc = new TextEncoder(), parts = [], offs = []; let pos = 0;
  const put = x => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); pos += b.length; };
  const obj = (n, body) => { offs[n] = pos; put(`${n} 0 obj\n${body}\nendobj\n`); };
  put('%PDF-1.4\n%âãÏÓ\n');
  const n = pages.length, kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  for (let i = 0; i < n; i++) {
    const blob = await new Promise(r => pages[i].toBlob(r, 'image/jpeg', 0.86));
    const jpg = new Uint8Array(await blob.arrayBuffer());
    const pg = 3 + i * 3, ct = pg + 1, im = pg + 2, content = 'q 595.28 0 0 841.89 0 0 cm /Im0 Do Q';
    obj(pg, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${ct} 0 R >>`);
    obj(ct, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    offs[im] = pos;
    put(`${im} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pages[i].width} /Height ${pages[i].height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
    put(jpg); put('\nendstream\nendobj\n');
  }
  const total = 3 + n * 3, xref = pos;
  put(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) put(String(offs[i]).padStart(10, '0') + ' 00000 n \n');
  put(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

async function saveRecord() {
  const caseNo = $('#f-case').value.trim(), recipient = $('#f-rcpt').value.trim(), tracking = $('#f-track').value.trim();
  if (!caseNo || !recipient) return toast('กรุณากรอกเลขคดีและชื่อผู้รับ');
  if (!items.length) return toast('ยังไม่มีรูปใบฟ้า');
  const btn = $('#b-save'); btn.disabled = true; btn.textContent = 'กำลังสร้าง PDF…';
  try {
    const now = new Date(), names = makeNames(caseNo, recipient, tracking, now);
    const dateText = now.toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' });
    const pages = buildPages(items, { caseNo, recipient, tracking, dateText }, +$('#f-per').value);
    const pdf = await makePdf(pages);
    const rec = { id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`, caseNo, recipient, tracking, created: now.toISOString(), dateText, images: items.length, ...names, pdf, status: 'pending' };
    await dbPut(rec);
    LS.set('lastCase', caseNo);
    items = []; renderThumbs(); $('#f-rcpt').value = ''; $('#f-track').value = ''; renderFileName();
    if (account()) { toast('สร้าง PDF แล้ว กำลังอัปโหลด…'); await uploadRecord(rec, true); }
    else await shareRecord(rec, true); // ไม่ได้ผูก OneDrive: เปิดเมนูแชร์ของ Android ให้เลือก OneDrive
    show('list');
  } catch (e) { toast('สร้าง PDF ไม่สำเร็จ: ' + e.message, 6000); }
  btn.disabled = false; btn.textContent = 'สร้าง PDF และอัปโหลด';
}

/* ===== OneDrive ===== */
let msalApp = null;
async function initAuth() {
  if (!cfg.clientId || !window.msal) return;
  try {
    msalApp = new msal.PublicClientApplication({
      auth: { clientId: cfg.clientId, authority: 'https://login.microsoftonline.com/consumers', redirectUri: REDIRECT },
      cache: { cacheLocation: 'localStorage' }
    });
    await msalApp.handleRedirectPromise();
  } catch (e) { toast('เข้าสู่ระบบไม่สำเร็จ: ' + e.message, 6000); }
}
const account = () => msalApp?.getAllAccounts()[0] || null;
async function getToken() {
  const acct = account(); if (!acct) return null;
  try { return (await msalApp.acquireTokenSilent({ scopes: SCOPES, account: acct })).accessToken; }
  catch { return null; }
}
async function uploadRecord(rec, notify) {
  const fail = async (msg, status = 'pending') => { rec.status = status; rec.error = msg; await dbPut(rec); if (notify) toast(msg, 6000); renderList(); return false; };
  if (!navigator.onLine) return fail('ไม่มีอินเทอร์เน็ต เก็บเข้าคิวไว้แล้ว จะอัปโหลดเองเมื่อออนไลน์');
  if (!msalApp) return fail('ยังไม่ได้ตั้งค่า OneDrive (ดูหน้า "ตั้งค่า") ไฟล์ PDF เก็บอยู่ในทะเบียน');
  const token = await getToken();
  if (!token) return fail('ยังไม่ได้เข้าสู่ระบบ OneDrive หรือหมดอายุ กรุณาเข้าสู่ระบบในหน้า "ตั้งค่า"');
  try {
    const path = `${rec.folder}/${rec.fileName}`.split('/').map(encodeURIComponent).join('/');
    const r = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${path}:/content?@microsoft.graph.conflictBehavior=rename`, {
      method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/pdf' }, body: rec.pdf
    });
    if (!r.ok) return fail(`อัปโหลดไม่สำเร็จ (รหัส ${r.status})`, 'error');
    const j = await r.json();
    rec.status = 'uploaded'; rec.error = ''; rec.webUrl = j.webUrl || ''; rec.uploadedName = j.name || rec.fileName;
    await dbPut(rec); if (notify) toast('อัปโหลดเข้า OneDrive แล้ว ✓'); renderList(); return true;
  } catch (e) { return fail('อัปโหลดไม่สำเร็จ จะลองใหม่อัตโนมัติ'); }
}
let syncing = false;
async function syncPending() {
  if (syncing || !navigator.onLine || !account()) return;
  syncing = true;
  try { for (const r of await dbAll()) if (r.status === 'pending' || r.status === 'error') await uploadRecord(r, false); } finally { syncing = false; }
}

/* ===== ทะเบียน ===== */
const STATUS = { uploaded: 'อัปโหลดแล้ว', shared: 'ส่งออกแล้ว', pending: 'ยังไม่ได้ส่ง', error: 'อัปโหลดไม่สำเร็จ' };
async function renderList() {
  const q = $('#q').value.trim().toLowerCase(), box = $('#recs');
  const all = (await dbAll()).sort((a, b) => b.created.localeCompare(a.created))
    .filter(r => !q || [r.caseNo, r.recipient, r.tracking, r.fileName].join(' ').toLowerCase().includes(q));
  box.replaceChildren();
  if (!all.length) return box.append(el('p', { className: 'hint', textContent: q ? 'ไม่พบรายการ' : 'ยังไม่มีรายการ' }));
  for (const r of all) {
    const acts = el('div', { className: 'acts' },
      el('button', { className: 'small', textContent: 'เปิด PDF', onclick: () => window.open(URL.createObjectURL(r.pdf), '_blank') }),
      el('button', { className: 'small' + (!msalApp && r.status === 'pending' ? ' primary' : ''), textContent: 'แชร์/บันทึก', onclick: () => shareRecord(r) }));
    if (r.status !== 'uploaded' && msalApp) acts.append(el('button', { className: 'small primary', textContent: 'อัปโหลด', onclick: () => uploadRecord(r, true) }));
    acts.append(el('button', { className: 'small danger', textContent: 'ลบ', onclick: async () => {
      const extra = r.status === 'pending' || r.status === 'error' ? '\n(ไฟล์นี้ยังไม่ได้ส่งเข้า OneDrive จะหายถาวร)' : '\n(ไฟล์ที่ส่งเข้า OneDrive แล้วยังอยู่)';
      if (confirm(`ลบรายการนี้ออกจากเครื่อง?\n${r.fileName}${extra}`)) { await dbDel(r.id); renderList(); }
    } }));
    box.append(el('div', { className: 'rec' },
      el('div', { className: 'name', textContent: r.uploadedName || r.fileName }),
      el('div', { className: 'meta' }, `${r.dateText} · ${r.images} รูป · `, el('span', { className: 'badge ' + (r.status === 'shared' ? 'uploaded' : r.status), textContent: STATUS[r.status] }),
        r.error ? el('div', { textContent: r.error }) : ''),
      acts));
  }
}
async function shareRecord(r, auto) {
  const file = new File([r.pdf], r.fileName, { type: 'application/pdf' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: r.fileName });
      if (r.status !== 'uploaded') { r.status = 'shared'; r.error = ''; await dbPut(r); }
      toast('ส่งออกแล้ว ✓ ตรวจในแอพ OneDrive ว่าไฟล์ขึ้นครบ', 5000);
    } catch (e) {
      if (e.name === 'AbortError') { if (auto) toast('ยังไม่ได้ส่ง ไฟล์อยู่ในทะเบียน กด "แชร์/บันทึก" ได้ภายหลัง', 6000); }
      else toast('เปิดเมนูแชร์ไม่ได้ กด "แชร์/บันทึก" ในทะเบียนอีกครั้ง', 6000);
    }
    renderList(); return;
  }
  const a = el('a', { href: URL.createObjectURL(r.pdf), download: r.fileName }); a.click();
}

/* ===== ตั้งค่า + นำทาง ===== */
function renderSettings() {
  const a = account();
  $('#acct').textContent = !cfg.clientId ? 'ไม่ได้ผูกบัญชี: แอพจะเปิดเมนูแชร์ให้เลือก OneDrive หลังสร้าง PDF (ไม่ต้องตั้งค่าหน้านี้)'
    : a ? `เข้าสู่ระบบแล้ว: ${a.username}` : 'ยังไม่ได้เข้าสู่ระบบ';
  $('#b-login').disabled = !msalApp || !!a; $('#b-logout').disabled = !a;
  $('#s-client').value = cfg.clientId; $('#s-root').value = cfg.root; $('#s-redirect').textContent = REDIRECT;
}
function show(v) {
  for (const s of ['capture', 'list', 'settings']) $('#v-' + s).hidden = s !== v;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  if (v === 'list') renderList();
  if (v === 'settings') renderSettings();
}
function renderNet() { $('#net').textContent = navigator.onLine ? '' : 'ออฟไลน์'; }

async function main() {
  document.querySelectorAll('nav button').forEach(b => (b.onclick = () => show(b.dataset.v)));
  $('#b-cam').onclick = () => $('#in-cam').click();
  $('#b-pick').onclick = () => $('#in-pick').click();
  for (const id of ['#in-cam', '#in-pick']) $(id).onchange = async ev => { const fs = [...ev.target.files]; ev.target.value = ''; await addFiles(fs); };
  for (const id of ['#f-case', '#f-rcpt', '#f-track']) $(id).oninput = renderFileName;
  $('#b-save').onclick = saveRecord;
  $('#q').oninput = renderList;
  $('#b-login').onclick = () => msalApp.loginRedirect({ scopes: SCOPES, prompt: 'select_account' });
  $('#b-logout').onclick = async () => { await msalApp.logoutRedirect({ account: account(), onRedirectNavigate: () => false }); renderSettings(); };
  $('#b-savecfg').onclick = () => { LS.set('clientId', $('#s-client').value.trim()); LS.set('rootFolder', $('#s-root').value.trim()); location.reload(); };
  initEditor();
  $('#f-case').value = LS.get('lastCase'); renderFileName(); renderNet();
  window.addEventListener('online', () => { renderNet(); syncPending(); });
  window.addEventListener('offline', renderNet);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && syncPending());
  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  await initAuth();
  syncPending();
}
main();
