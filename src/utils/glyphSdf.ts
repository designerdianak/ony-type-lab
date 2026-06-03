import type opentype from 'opentype.js';
import { fillGlyphPath } from './opentypeCanvas';
import { extractIsoContour, type GlyphSlot } from './contourField';

const INF = 1e15;

export type SdfGrid = {
  sdf: Float32Array;
  cw: number;
  ch: number;
  cell: number;
};

/** Felzenszwalb 1D squared distance transform (f[i]=0 на «источнике»). */
function edt1d(f: Float32Array, d: Float32Array, n: number) {
  const v = new Int32Array(n);
  const z = new Float32Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;

  for (let q = 1; q < n; q++) {
    let s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dx = q - v[k]!;
    d[q] = f[v[k]!]! + dx * dx;
  }
}

function edt2d(grid: Float32Array, w: number, h: number) {
  const tmp = new Float32Array(w * h);
  const row = new Float32Array(Math.max(w, h));
  const rowD = new Float32Array(Math.max(w, h));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) row[x] = grid[y * w + x]!;
    edt1d(row, rowD, w);
    for (let x = 0; x < w; x++) tmp[y * w + x] = rowD[x]!;
  }

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) row[y] = tmp[y * w + x]!;
    edt1d(row, rowD, h);
    for (let y = 0; y < h; y++) grid[y * w + x] = rowD[y]!;
  }
}

function rasterMask(
  w: number,
  h: number,
  slots: GlyphSlot[],
  fontCss: string,
  fontSize: number,
  font: opentype.Font | null,
): Uint8Array {
  const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
  const pw = Math.max(1, Math.floor(w * dpr));
  const ph = Math.max(1, Math.floor(h * dpr));

  const off = document.createElement('canvas');
  off.width = pw;
  off.height = ph;
  const octx = off.getContext('2d');
  const mask = new Uint8Array(w * h);
  if (!octx) return mask;

  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.fillStyle = '#fff';
  octx.textBaseline = 'alphabetic';
  if (font) {
    for (const g of slots) fillGlyphPath(octx, font.getPath(g.char, g.x, g.bl, fontSize), '#fff');
  } else {
    octx.font = fontCss;
    for (const g of slots) octx.fillText(g.char, g.x, g.bl);
  }

  const img = octx.getImageData(0, 0, pw, ph).data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = Math.min(pw - 1, Math.floor(x * dpr));
      const py = Math.min(ph - 1, Math.floor(y * dpr));
      if (img[(py * pw + px) * 4 + 3]! > 48) mask[y * w + x] = 1;
    }
  }
  return mask;
}

/** Signed distance: внутри буквы < 0, снаружи > 0 (в пикселях логического холста). */
export function buildGlyphSdf(
  w: number,
  h: number,
  cell: number,
  slots: GlyphSlot[],
  fontCss: string,
  fontSize: number,
  font: opentype.Font | null,
): SdfGrid {
  const cw = Math.max(1, Math.ceil(w / cell));
  const ch = Math.max(1, Math.ceil(h / cell));
  const mask = rasterMask(w, h, slots, fontCss, fontSize, font);

  const coarse = new Uint8Array(cw * ch);
  for (let gy = 0; gy < ch; gy++) {
    for (let gx = 0; gx < cw; gx++) {
      const lx = Math.min(w - 1, Math.floor((gx + 0.5) * cell));
      const ly = Math.min(h - 1, Math.floor((gy + 0.5) * cell));
      coarse[gy * cw + gx] = mask[ly * w + lx]!;
    }
  }

  const outDist = new Float32Array(cw * ch);
  const inDist = new Float32Array(cw * ch);

  for (let i = 0; i < cw * ch; i++) {
    outDist[i] = coarse[i] ? 0 : INF;
    inDist[i] = coarse[i] ? INF : 0;
  }

  edt2d(outDist, cw, ch);
  edt2d(inDist, cw, ch);

  const sdf = new Float32Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) {
    if (coarse[i]) {
      sdf[i] = -Math.sqrt(inDist[i]!);
    } else {
      sdf[i] = Math.sqrt(outDist[i]!);
    }
    sdf[i] = sdf[i]! * cell;
  }

  return { sdf, cw, ch, cell };
}

export function sdfMaxDistance(sdf: Float32Array): number {
  let mx = 0;
  for (let i = 0; i < sdf.length; i++) {
    const v = sdf[i]!;
    if (v > 0 && v > mx) mx = v;
  }
  return mx;
}

/** Изолиния sdf = level (только снаружи, level > 0). */
export function extractSdfIsoline(
  grid: SdfGrid,
  level: number,
  out: { x0: number; y0: number; x1: number; y1: number }[],
) {
  extractIsoContour(grid.sdf, grid.cw, grid.ch, level, grid.cell, out);
}

function sdfFalloff(absD: number, radius: number): number {
  if (absD >= radius) return 0;
  const t = 1 - absD / radius;
  return t * t * (3 - 2 * t);
}

/**
 * Референс 36DaysOfType: горизонтали, чья Y сдвигается от SDF букв;
 * фаза `phase` двигает кольца наружу (~1 spacing / кадр при 30 fps).
 * Кривая уровня: y + strength·w·sdf(x,y) = level.
 */
export function drawSdfWarpedHorizontals(
  ctx: CanvasRenderingContext2D,
  grid: SdfGrid,
  w: number,
  h: number,
  spacing: number,
  influenceRadius: number,
  strength: number,
  stroke: string,
  lineWidth: number,
  alpha: number,
  phase: number,
) {
  const { sdf, cw, ch, cell } = grid;
  const sample = (lx: number, ly: number) => {
    const gx = Math.max(0, Math.min(cw - 1, lx / cell));
    const gy = Math.max(0, Math.min(ch - 1, ly / cell));
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = Math.min(cw - 1, x0 + 1);
    const y1 = Math.min(ch - 1, y0 + 1);
    const tx = gx - x0;
    const ty = gy - y0;
    const v00 = sdf[y0 * cw + x0]!;
    const v10 = sdf[y0 * cw + x1]!;
    const v01 = sdf[y1 * cw + x0]!;
    const v11 = sdf[y1 * cw + x1]!;
    return (
      v00 * (1 - tx) * (1 - ty) +
      v10 * tx * (1 - ty) +
      v01 * (1 - tx) * ty +
      v11 * tx * ty
    );
  };

  const step = Math.max(1.5, Math.min(3, cell * 0.45));
  const bandCount = Math.ceil((h + spacing * 2) / spacing) + 4;
  const bandStart = Math.floor((-spacing - phase) / spacing) - 2;

  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = alpha;

  for (let bi = 0; bi < bandCount; bi++) {
    const level = (bandStart + bi) * spacing + phase;
    ctx.beginPath();
    let started = false;

    for (let x = 0; x <= w; x += step) {
      let y = level;
      for (let iter = 0; iter < 2; iter++) {
        const d = sample(x, y);
        const wgt = sdfFalloff(Math.abs(d), influenceRadius);
        y = level - strength * wgt * d;
      }
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}
