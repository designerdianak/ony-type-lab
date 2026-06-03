import { extractIsoContour } from './contourField';

type Seg = { x0: number; y0: number; x1: number; y1: number };
type Pt = { x: number; y: number };

function ptKey(x: number, y: number): string {
  return `${Math.round(x * 4)},${Math.round(y * 4)}`;
}

/** Соединяет отрезки marching squares в замкнутые полигоны. */
export function stitchClosedLoops(segments: Seg[]): Pt[][] {
  if (segments.length === 0) return [];

  const adj = new Map<string, Pt[]>();
  const pointAt = new Map<string, Pt>();

  const link = (a: Pt, b: Pt) => {
    const ka = ptKey(a.x, a.y);
    const kb = ptKey(b.x, b.y);
    pointAt.set(ka, a);
    pointAt.set(kb, b);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka)!.push(b);
    adj.get(kb)!.push(a);
  };

  const edgeUsed = new Set<string>();
  const edgeKey = (a: Pt, b: Pt) => {
    const ka = ptKey(a.x, a.y);
    const kb = ptKey(b.x, b.y);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };

  for (const s of segments) {
    const a = { x: s.x0, y: s.y0 };
    const b = { x: s.x1, y: s.y1 };
    link(a, b);
    edgeUsed.add(edgeKey(a, b));
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

/** Граница залитой области маски (iso 0.5). */
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

function dilateDisk(mask: Uint8Array, cw: number, ch: number, radius: number): Uint8Array {
  const r = Math.max(1, Math.round(radius));
  const out = new Uint8Array(mask.length);
  const r2 = r * r;

  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (!mask[y * cw + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= ch) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r2) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= cw) continue;
          out[yy * cw + xx] = 1;
        }
      }
    }
  }
  return out;
}

function boxBlurMask(mask: Uint8Array, cw: number, ch: number): Float32Array {
  const src = new Float32Array(mask.length);
  const tmp = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) src[i] = mask[i] ? 1 : 0;

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
          sum += src[yy * cw + xx]!;
          n++;
        }
      }
      tmp[y * cw + x] = sum / n;
    }
  }
  return tmp;
}

/** Следующий контур = расширение предыдущего + лёгкое сглаживание (углы смягчаются). */
export function expandMaskStep(
  prev: Uint8Array,
  cw: number,
  ch: number,
  radiusCells: number,
  smoothPasses: number,
  threshold: number,
): Uint8Array {
  let cur = dilateDisk(prev, cw, ch, radiusCells);

  for (let p = 0; p < smoothPasses; p++) {
    const blurred = boxBlurMask(cur, cw, ch);
    const next = new Uint8Array(cur.length);
    for (let i = 0; i < cur.length; i++) {
      next[i] = blurred[i]! >= threshold ? 1 : 0;
    }
    cur = next;
  }

  return cur;
}

function strokeLoops(
  ctx: CanvasRenderingContext2D,
  loops: Pt[][],
  stroke: string,
  lineWidth: number,
) {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (const loop of loops) {
    if (loop.length < 3) continue;
    ctx.beginPath();
    ctx.moveTo(loop[0]!.x, loop[0]!.y);
    for (let i = 1; i < loop.length; i++) ctx.lineTo(loop[i]!.x, loop[i]!.y);
    ctx.closePath();
    ctx.stroke();
  }
}

/**
 * Замкнутый контур: заливка всей области маски + обводка по границе.
 * Внешний слой перекрывает внутренние заливкой — видны только обводки.
 */
export function drawMaskContourLayer(
  ctx: CanvasRenderingContext2D,
  mask: Uint8Array,
  cw: number,
  ch: number,
  cell: number,
  fill: string | null,
  stroke: string,
  lineWidth: number,
  alpha: number,
  segBuf: Seg[],
) {
  const pw = Math.ceil(cw * cell);
  const ph = Math.ceil(ch * cell);

  const off = document.createElement('canvas');
  off.width = cw;
  off.height = ch;
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

  const loops = extractMaskLoops(mask, cw, ch, cell, segBuf);
  strokeLoops(ctx, loops, stroke, lineWidth);
  ctx.restore();
}
