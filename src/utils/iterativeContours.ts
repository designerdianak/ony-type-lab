import { extractIsoContour } from './contourField';

type Seg = { x0: number; y0: number; x1: number; y1: number };
export type Pt = { x: number; y: number };

function ptKey(x: number, y: number): string {
  return `${Math.round(x * 4)},${Math.round(y * 4)}`;
}

export function stitchClosedLoops(segments: Seg[]): Pt[][] {
  if (segments.length === 0) return [];

  const adj = new Map<string, Pt[]>();

  const link = (a: Pt, b: Pt) => {
    const ka = ptKey(a.x, a.y);
    const kb = ptKey(b.x, b.y);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka)!.push(b);
    adj.get(kb)!.push(a);
  };

  const edgeKey = (a: Pt, b: Pt) => {
    const ka = ptKey(a.x, a.y);
    const kb = ptKey(b.x, b.y);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };

  for (const s of segments) {
    link({ x: s.x0, y: s.y0 }, { x: s.x1, y: s.y1 });
  }

  const loops: Pt[][] = [];
  const visitedEdges = new Set<string>();

  for (const s of segments) {
    const start = { x: s.x0, y: s.y0 };
    const next = { x: s.x1, y: s.y1 };
    const ek = edgeKey(start, next);
    if (visitedEdges.has(ek)) continue;

    const loop: Pt[] = [start];
    let prev = start;
    let cur = next;
    visitedEdges.add(ek);

    for (let guard = 0; guard < segments.length + 8; guard++) {
      loop.push(cur);
      const ck = ptKey(cur.x, cur.y);
      const neighbors = adj.get(ck) ?? [];
      let found: Pt | null = null;

      for (const nb of neighbors) {
        const e = edgeKey(cur, nb);
        if (visitedEdges.has(e)) continue;
        if (ptKey(nb.x, nb.y) === ptKey(prev.x, prev.y)) continue;
        found = nb;
        visitedEdges.add(e);
        break;
      }

      if (!found) break;
      if (ptKey(found.x, found.y) === ptKey(start.x, start.y) && loop.length > 2) {
        loops.push(loop);
        break;
      }
      prev = cur;
      cur = found;
    }
  }

  return loops;
}

function maskToField(mask: Uint8Array): Float32Array {
  const field = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) field[i] = mask[i] ? 1 : 0;
  return field;
}

export function extractMaskLoops(
  mask: Uint8Array,
  cw: number,
  ch: number,
  cell: number,
  segBuf: Seg[],
): Pt[][] {
  segBuf.length = 0;
  extractIsoContour(maskToField(mask), cw, ch, 0.5, cell, segBuf);
  return stitchClosedLoops(segBuf);
}

/** Быстрое расширение: separable max-filter (приближение диска). */
function dilateSeparable(src: Uint8Array, dst: Uint8Array, cw: number, ch: number, r: number) {
  const rad = Math.max(1, Math.round(r));
  const tmp = new Uint8Array(src.length);

  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let v = 0;
      for (let dx = -rad; dx <= rad; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= cw) continue;
        if (src[y * cw + xx]) v = 1;
      }
      tmp[y * cw + x] = v;
    }
  }

  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let v = 0;
      for (let dy = -rad; dy <= rad; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= ch) continue;
        if (tmp[yy * cw + x]) v = 1;
      }
      dst[y * cw + x] = v;
    }
  }
}

function boxBlurMask(mask: Uint8Array, cw: number, ch: number, out: Float32Array) {
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= ch) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= cw) continue;
          sum += mask[yy * cw + xx] ? 1 : 0;
          n++;
        }
      }
      out[y * cw + x] = sum / n;
    }
  }
}

export function expandMaskStep(
  prev: Uint8Array,
  cw: number,
  ch: number,
  radiusCells: number,
  smoothPasses: number,
  threshold: number,
  bufA?: Uint8Array,
  bufB?: Uint8Array,
): Uint8Array {
  const out = bufA ?? new Uint8Array(prev.length);
  const tmp = bufB ?? new Uint8Array(prev.length);
  dilateSeparable(prev, out, cw, ch, radiusCells);

  let cur = out;
  let next = tmp;
  const blur = new Float32Array(prev.length);

  for (let p = 0; p < smoothPasses; p++) {
    boxBlurMask(cur, cw, ch, blur);
    for (let i = 0; i < cur.length; i++) next[i] = blur[i]! >= threshold ? 1 : 0;
    const swap = cur;
    cur = next;
    next = swap;
  }

  return new Uint8Array(cur);
}

export type ContourChain = {
  masks: Uint8Array[];
  loops: Pt[][][];
  cw: number;
  ch: number;
  cell: number;
};

export function buildContourChain(
  glyphMask: Uint8Array,
  cw: number,
  ch: number,
  cell: number,
  count: number,
  radiusCells: number,
  smoothPasses: number,
  threshold: number,
  segBuf: Seg[],
): ContourChain {
  const n = Math.max(1, Math.min(150, Math.round(count)));
  const masks: Uint8Array[] = [];
  const loops: Pt[][][] = [];

  const bufA = new Uint8Array(glyphMask.length);
  const bufB = new Uint8Array(glyphMask.length);

  let cur = new Uint8Array(glyphMask);
  masks.push(cur);
  loops.push(extractMaskLoops(cur, cw, ch, cell, segBuf));

  for (let i = 1; i < n; i++) {
    cur = expandMaskStep(cur, cw, ch, radiusCells, smoothPasses, threshold, bufA, bufB);
    masks.push(cur);
    loops.push(extractMaskLoops(cur, cw, ch, cell, segBuf));
  }

  return { masks, loops, cw, ch, cell };
}

function appendLoop(ctx: CanvasRenderingContext2D, loop: Pt[]) {
  ctx.moveTo(loop[0]!.x, loop[0]!.y);
  for (let i = 1; i < loop.length; i++) ctx.lineTo(loop[i]!.x, loop[i]!.y);
  ctx.closePath();
}

function ensureMaskScratch(
  scratch: HTMLCanvasElement | null,
  cw: number,
  ch: number,
): HTMLCanvasElement {
  if (scratch && scratch.width === cw && scratch.height === ch) return scratch;
  const c = scratch ?? document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  return c;
}

function paintMaskInterior(
  ctx: CanvasRenderingContext2D,
  mask: Uint8Array,
  cw: number,
  ch: number,
  cell: number,
  fill: string | null,
  alpha: number,
  scratch: HTMLCanvasElement,
) {
  const pw = Math.ceil(cw * cell);
  const ph = Math.ceil(ch * cell);
  const off = ensureMaskScratch(scratch, cw, ch);
  const octx = off.getContext('2d');
  if (!octx) return;

  const img = octx.createImageData(cw, ch);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const p = i * 4;
    img.data[p] = 255;
    img.data[p + 1] = 255;
    img.data[p + 2] = 255;
    img.data[p + 3] = 255;
  }
  octx.putImageData(img, 0, 0);

  ctx.save();
  ctx.globalAlpha = alpha;
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, pw, ph);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, cw, ch, 0, 0, pw, ph);
    ctx.globalCompositeOperation = 'source-over';
  } else {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, cw, ch, 0, 0, pw, ph);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
}

/**
 * Один контур по ТЗ: заливка фоном по области фигуры, затем обводка.
 * Рисовать от центра к краям — внешние заливки перекрывают внутренние линии.
 */
export function drawFilledContourLayer(
  ctx: CanvasRenderingContext2D,
  loops: Pt[][],
  mask: Uint8Array,
  cw: number,
  ch: number,
  cell: number,
  fill: string | null,
  stroke: string,
  lineWidth: number,
  alpha: number,
  scratch: HTMLCanvasElement,
) {
  paintMaskInterior(ctx, mask, cw, ch, cell, fill, alpha, scratch);

  const valid = loops.filter((l) => l.length >= 3);
  if (valid.length === 0) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (const loop of valid) {
    ctx.beginPath();
    appendLoop(ctx, loop);
    ctx.stroke();
  }

  ctx.restore();
}
