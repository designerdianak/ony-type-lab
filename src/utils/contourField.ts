import type opentype from 'opentype.js';
import { fillGlyphPath } from './opentypeCanvas';

export type GlyphSlot = { char: string; x: number; bl: number };

/** Маска глифов (1 = внутри буквы) на сетке. */
export function rasterizeGlyphMask(
  w: number,
  h: number,
  cell: number,
  slots: GlyphSlot[],
  fontCss: string,
  fontSize: number,
  font: opentype.Font | null,
): { mask: Uint8Array; cw: number; ch: number } {
  const cw = Math.max(1, Math.ceil(w / cell));
  const ch = Math.max(1, Math.ceil(h / cell));
  const mask = new Uint8Array(cw * ch);

  const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
  const pw = Math.max(1, Math.floor(w * dpr));
  const ph = Math.max(1, Math.floor(h * dpr));

  const off = document.createElement('canvas');
  off.width = pw;
  off.height = ph;
  const octx = off.getContext('2d');
  if (!octx) return { mask, cw, ch };

  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.fillStyle = '#ffffff';
  octx.textBaseline = 'alphabetic';
  octx.textAlign = 'left';

  if (font) {
    for (const g of slots) {
      fillGlyphPath(octx, font.getPath(g.char, g.x, g.bl, fontSize), '#ffffff');
    }
  } else {
    octx.font = fontCss;
    for (const g of slots) octx.fillText(g.char, g.x, g.bl);
  }

  octx.setTransform(1, 0, 0, 1, 0, 0);
  const img = octx.getImageData(0, 0, pw, ph).data;
  for (let gy = 0; gy < ch; gy++) {
    for (let gx = 0; gx < cw; gx++) {
      const lx = Math.min(w - 1, (gx + 0.5) * cell);
      const ly = Math.min(h - 1, (gy + 0.5) * cell);
      const px = Math.min(pw - 1, Math.floor(lx * dpr));
      const py = Math.min(ph - 1, Math.floor(ly * dpr));
      const i = (py * pw + px) * 4;
      if (img[i + 3]! > 48) mask[gy * cw + gx] = 1;
    }
  }
  return { mask, cw, ch };
}

/** Расстояние от каждой ячейки до ближайшего пикселя буквы (chamfer, в шагах сетки). */
export function chamferDistance(mask: Uint8Array, cw: number, ch: number): Float32Array {
  const n = cw * ch;
  const d = new Float32Array(n);
  const INF = 1e7;
  for (let i = 0; i < n; i++) d[i] = mask[i] ? 0 : INF;

  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = y * cw + x;
      let v = d[i]!;
      if (x > 0) v = Math.min(v, d[i - 1]! + 1);
      if (y > 0) v = Math.min(v, d[i - cw]! + 1);
      if (x > 0 && y > 0) v = Math.min(v, d[i - cw - 1]! + 1.414);
      d[i] = v;
    }
  }
  for (let y = ch - 1; y >= 0; y--) {
    for (let x = cw - 1; x >= 0; x--) {
      const i = y * cw + x;
      let v = d[i]!;
      if (x < cw - 1) v = Math.min(v, d[i + 1]! + 1);
      if (y < ch - 1) v = Math.min(v, d[i + cw]! + 1);
      if (x < cw - 1 && y < ch - 1) v = Math.min(v, d[i + cw + 1]! + 1.414);
      d[i] = v;
    }
  }
  return d;
}

type Seg = { x0: number; y0: number; x1: number; y1: number };

function lerpT(v0: number, v1: number, iso: number): number {
  const d = v1 - v0;
  if (Math.abs(d) < 1e-6) return 0.5;
  return Math.max(0, Math.min(1, (iso - v0) / d));
}

/** Рёбра ячейки: 0=низ 1=право 2=верх 3=лево (экран, y вниз). */
const LINE_TABLE: number[][] = [
  [],
  [0, 3],
  [1, 2],
  [0, 1, 2, 3],
  [2, 3],
  [0, 2],
  [0, 1, 3],
  [0, 1],
  [0, 1],
  [0, 1, 2, 3],
  [1, 2],
  [1, 2, 3],
  [0, 3],
  [2, 3],
  [1, 3],
  [],
];

/** Изолиния dist = iso (в шагах сетки) → отрезки в пикселях. */
export function extractIsoContour(
  dist: Float32Array,
  cw: number,
  ch: number,
  iso: number,
  cell: number,
  out: Seg[],
) {
  const at = (x: number, y: number) => dist[y * cw + x]!;
  const px = (gx: number) => gx * cell;
  const py = (gy: number) => gy * cell;

  for (let y = 0; y < ch - 1; y++) {
    for (let x = 0; x < cw - 1; x++) {
      const tl = at(x, y);
      const tr = at(x + 1, y);
      const br = at(x + 1, y + 1);
      const bl = at(x, y + 1);

      let idx = 0;
      if (bl >= iso) idx |= 1;
      if (br >= iso) idx |= 2;
      if (tr >= iso) idx |= 4;
      if (tl >= iso) idx |= 8;

      const lines = LINE_TABLE[idx];
      if (!lines || lines.length === 0) continue;

      const e0 = { x: px(x + lerpT(bl, br, iso)), y: py(y + 1) };
      const e1 = { x: px(x + 1), y: py(y + 1 - lerpT(br, tr, iso)) };
      const e2 = { x: px(x + lerpT(tl, tr, iso)), y: py(y) };
      const e3 = { x: px(x), y: py(y + 1 - lerpT(bl, tl, iso)) };
      const edge = [e0, e1, e2, e3];

      for (let i = 0; i < lines.length; i += 2) {
        const a = edge[lines[i]!]!;
        const b = edge[lines[i + 1]!]!;
        out.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
      }
    }
  }
}

export function drawContourSegments(
  ctx: CanvasRenderingContext2D,
  segments: Seg[],
  stroke: string,
  lineWidth: number,
  alpha: number,
) {
  if (segments.length === 0) return;
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  for (const s of segments) {
    ctx.moveTo(s.x0, s.y0);
    ctx.lineTo(s.x1, s.y1);
  }
  ctx.stroke();
  ctx.restore();
}
