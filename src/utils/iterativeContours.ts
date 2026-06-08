import { extractIsoContour } from './contourField';

type Seg = { x0: number; y0: number; x1: number; y1: number };
export type Pt = { x: number; y: number };

/** Параметры шага Shapeₙ = Smooth(Offset(Shapeₙ₋₁)). */
export type ShapeStepParams = {
  radiusCells: number;
  baseSmoothPasses: number;
  baseThreshold: number;
  /** 0…1 — сильнее выпрямляет дальние контуры */
  waveFlatten: number;
  /** с какого шага включать Smooth (раньше — только Offset) */
  smoothFromStep: number;
};

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

/** Граница маски по рёбрам сетки (надёжнее marching squares). */
function collectBoundarySegments(
  mask: Uint8Array,
  cw: number,
  ch: number,
  cell: number,
  out: Seg[],
): void {
  out.length = 0;
  const inside = (gx: number, gy: number) =>
    gx >= 0 && gx < cw && gy >= 0 && gy < ch && mask[gy * cw + gx] === 1;
  const px = (gx: number) => gx * cell;
  const py = (gy: number) => gy * cell;

  for (let gy = 0; gy < ch; gy++) {
    for (let gx = 0; gx < cw; gx++) {
      if (!inside(gx, gy)) continue;
      if (!inside(gx, gy - 1)) out.push({ x0: px(gx), y0: py(gy), x1: px(gx + 1), y1: py(gy) });
      if (!inside(gx, gy + 1)) out.push({ x0: px(gx), y0: py(gy + 1), x1: px(gx + 1), y1: py(gy + 1) });
      if (!inside(gx - 1, gy)) out.push({ x0: px(gx), y0: py(gy), x1: px(gx), y1: py(gy + 1) });
      if (!inside(gx + 1, gy)) out.push({ x0: px(gx + 1), y0: py(gy), x1: px(gx + 1), y1: py(gy + 1) });
    }
  }
}

export function extractMaskLoops(
  mask: Uint8Array,
  cw: number,
  ch: number,
  cell: number,
  segBuf: Seg[],
  originX = 0,
  originY = 0,
): Pt[][] {
  collectBoundarySegments(mask, cw, ch, cell, segBuf);
  if (segBuf.length === 0) {
    extractIsoContour(maskToField(mask), cw, ch, 0.5, cell, segBuf);
  }
  const loops = stitchClosedLoops(segBuf);
  if (originX === 0 && originY === 0) return loops;
  return loops.map((loop) =>
    loop.map((p) => ({ x: p.x + originX, y: p.y + originY })),
  );
}

export function maskHasInk(mask: Uint8Array): boolean {
  for (let i = 0; i < mask.length; i++) if (mask[i]) return true;
  return false;
}

function dilateDisk(mask: Uint8Array, cw: number, ch: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  dilateMaskInto(mask, out, cw, ch, radius);
  return out;
}

function boxBlurMaskSimple(mask: Uint8Array, cw: number, ch: number): Float32Array {
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

export function smoothBinaryMask(
  mask: Uint8Array,
  cw: number,
  ch: number,
  smoothPasses: number,
  threshold: number,
): Uint8Array {
  let cur = new Uint8Array(mask);
  const passes = Math.max(0, Math.round(smoothPasses));
  for (let p = 0; p < passes; p++) {
    const blurred = boxBlurMaskSimple(cur, cw, ch);
    const next = new Uint8Array(cur.length);
    for (let i = 0; i < cur.length; i++) next[i] = blurred[i]! >= threshold ? 1 : 0;
    cur = next;
  }
  return cur;
}

/**
 * Один шаг «раздувания» всего слова: изолиния поля расстояния + сглаживание.
 * Линии между буквами не пересекаются — один поток от общего силуэта.
 */
export function maskAtDistanceLevel(
  dist: Float32Array,
  level: number,
  radiusCells: number,
  cw: number,
  ch: number,
  smoothPasses: number,
  threshold: number,
  prev?: Uint8Array,
): Uint8Array {
  const iso = Math.max(0, level) * radiusCells;
  const raw = new Uint8Array(dist.length);
  for (let i = 0; i < raw.length; i++) raw[i] = dist[i]! <= iso ? 1 : 0;
  let cur =
    smoothPasses > 0 ? smoothBinaryMask(raw, cw, ch, smoothPasses, threshold) : raw;
  if (prev) {
    for (let i = 0; i < cur.length; i++) {
      if (prev[i]) cur[i] = 1;
    }
  }
  return cur;
}

export function extractDistanceLoops(
  dist: Float32Array,
  cw: number,
  ch: number,
  cell: number,
  iso: number,
  segBuf: Seg[],
): Pt[][] {
  extractIsoContour(dist, cw, ch, iso, cell, segBuf);
  return stitchClosedLoops(segBuf);
}

/**
 * Референс: кольца залиты фоном, обводки — гладкие изолинии поля расстояния.
 */
export function drawDistanceRippleStack(
  ctx: CanvasRenderingContext2D,
  masks: Uint8Array[],
  dist: Float32Array,
  cw: number,
  ch: number,
  cell: number,
  radiusCells: number,
  waveCount: number,
  fill: string | null,
  stroke: string,
  lineWidth: number,
  alpha: number,
  segBuf: Seg[],
  scratch: HTMLCanvasElement,
) {
  const n = Math.min(waveCount, masks.length - 1);
  for (let wave = 1; wave <= n; wave++) {
    paintRippleRing(
      ctx,
      masks[wave]!,
      masks[wave - 1]!,
      cw,
      ch,
      cell,
      0,
      0,
      fill,
      alpha,
      scratch,
    );
  }
  for (let wave = 1; wave <= n; wave++) {
    const loops = extractDistanceLoops(dist, cw, ch, cell, wave * radiusCells, segBuf);
    strokeContourLoops(ctx, loops, stroke, lineWidth, alpha);
  }
}

/**
 * Offset Path + Smooth: Shapeₙ = Smooth(Offset(Shapeₙ₋₁)).
 * Не repeater, не от исходной буквы.
 */
export function expandMaskStep(
  prev: Uint8Array,
  cw: number,
  ch: number,
  radiusCells: number,
  smoothPasses: number,
  threshold: number,
): Uint8Array {
  let cur = dilateDisk(prev, cw, ch, radiusCells);
  return smoothBinaryMask(cur, cw, ch, smoothPasses, threshold);
}

export type RippleStepParams = {
  radiusCells: number;
  smoothPasses: number;
  threshold: number;
};

/** Параметры одного шага Offset+Smooth для поколения gen. */
export function rippleStepParams(
  gen: number,
  baseRadius: number,
  farGen: number,
  waveFlatten: number,
  spacingMode: 'uniform' | 'accelerate',
  spacingSpread: number,
  edgeMode: 'uniform' | 'smoothNearText',
): RippleStepParams {
  let radiusCells = baseRadius;
  if (spacingMode === 'accelerate') {
    radiusCells = Math.max(0.45, baseRadius * (1 + gen * Math.max(0, spacingSpread)));
  }

  const baseSmooth = Math.round(1 + waveFlatten * 3);
  const baseThreshold = 0.46 - waveFlatten * 0.16;

  if (edgeMode === 'uniform') {
    return {
      radiusCells,
      smoothPasses: baseSmooth,
      threshold: baseThreshold + gen * 0.0012,
    };
  }

  const far = Math.max(1, farGen);
  const t = Math.min(1, gen / far);
  const sharp = 1 - waveFlatten;
  return {
    radiusCells,
    smoothPasses: baseSmooth + Math.round((1 - t) * sharp * 5),
    threshold: baseThreshold + t * sharp * 0.1 + gen * 0.0012,
  };
}

export function expandMaskGeneration(
  prev: Uint8Array,
  generation: number,
  cw: number,
  ch: number,
  baseRadius: number,
  waveFlatten: number,
  spacingMode: 'uniform' | 'accelerate',
  spacingSpread: number,
  edgeMode: 'uniform' | 'smoothNearText',
  farGen: number,
): Uint8Array {
  const p = rippleStepParams(
    generation,
    baseRadius,
    farGen,
    waveFlatten,
    spacingMode,
    spacingSpread,
    edgeMode,
  );
  return expandMaskStep(prev, cw, ch, p.radiusCells, p.smoothPasses, p.threshold);
}

/** Offset+Smooth в готовый буфер (без лишних аллокаций). */
export function expandMaskGenerationInto(
  prev: Uint8Array,
  out: Uint8Array,
  generation: number,
  cw: number,
  ch: number,
  baseRadius: number,
  waveFlatten: number,
  spacingMode: 'uniform' | 'accelerate',
  spacingSpread: number,
  edgeMode: 'uniform' | 'smoothNearText',
  farGen: number,
  work?: Uint8Array,
): Uint8Array {
  const p = rippleStepParams(
    generation,
    baseRadius,
    farGen,
    waveFlatten,
    spacingMode,
    spacingSpread,
    edgeMode,
  );
  dilateMaskInto(prev, out, cw, ch, p.radiusCells);
  if (p.smoothPasses <= 0) return out;
  const smoothed = smoothBinaryMask(out, cw, ch, p.smoothPasses, p.threshold);
  if (work && work.length === out.length) {
    work.set(smoothed);
    out.set(work);
    return out;
  }
  out.set(smoothed);
  return out;
}

/**
 * Cavalry: Shape1…ShapeN — каждое поколение залито цветом (внутренние → внешние).
 */
export function drawFilledGenerationStack(
  ctx: CanvasRenderingContext2D,
  masks: Uint8Array[],
  firstGen: number,
  lastGen: number,
  cw: number,
  ch: number,
  cell: number,
  originX: number,
  originY: number,
  colorForGen: (gen: number) => string,
  alpha: number,
  scratch: HTMLCanvasElement,
) {
  drawFilledGenerationRange(
    ctx,
    (g) => masks[g] ?? null,
    firstGen,
    lastGen,
    cw,
    ch,
    cell,
    originX,
    originY,
    colorForGen,
    alpha,
    scratch,
  );
}

/** Заливка диапазона поколений — маска берётся из lookup (rolling cache). */
export function drawFilledGenerationRange(
  ctx: CanvasRenderingContext2D,
  maskAt: (gen: number) => Uint8Array | null,
  firstGen: number,
  lastGen: number,
  cw: number,
  ch: number,
  cell: number,
  originX: number,
  originY: number,
  colorForGen: (gen: number) => string,
  alpha: number,
  scratch: HTMLCanvasElement,
) {
  const lo = Math.max(1, firstGen);
  const hi = lastGen;
  if (lo > hi) return;

  ctx.save();
  ctx.translate(originX, originY);
  for (let g = lo; g <= hi; g++) {
    const mask = maskAt(g);
    if (!mask) continue;
    paintMaskFull(ctx, mask, cw, ch, cell, colorForGen(g), alpha, scratch);
  }
  ctx.restore();
}

/** То же, но обводки из кэша (без extractMaskLoops на каждый кадр). */
export function drawOffsetContourCached(
  ctx: CanvasRenderingContext2D,
  maskAt: (gen: number) => Uint8Array | null,
  loopsAt: (gen: number) => Pt[][] | null,
  firstGen: number,
  lastGen: number,
  cw: number,
  ch: number,
  cell: number,
  originX: number,
  originY: number,
  ringFill: string | null,
  strokeForGen: (gen: number) => string,
  lineWidth: number,
  alpha: number,
  scratch: HTMLCanvasElement,
) {
  const lo = Math.max(1, firstGen);
  const hi = lastGen;
  if (lo > hi) return;

  ctx.save();
  ctx.translate(originX, originY);

  for (let g = lo; g <= hi; g++) {
    const mask = maskAt(g);
    const prev = maskAt(g - 1);
    if (!mask || !prev) continue;
    paintRippleRing(ctx, mask, prev, cw, ch, cell, 0, 0, ringFill, alpha, scratch);
  }

  for (let g = lo; g <= hi; g++) {
    const loops = loopsAt(g);
    if (!loops || loops.length === 0) continue;
    strokeContourLoops(ctx, loops, strokeForGen(g), lineWidth, alpha);
  }

  ctx.restore();
}

/**
 * Cavalry / 36Days: кольца залиты фоном, обводки поверх.
 * Каждое поколение — отдельная фигура, без union.
 */
export function drawOffsetContourRange(
  ctx: CanvasRenderingContext2D,
  maskAt: (gen: number) => Uint8Array | null,
  firstGen: number,
  lastGen: number,
  cw: number,
  ch: number,
  cell: number,
  originX: number,
  originY: number,
  ringFill: string | null,
  strokeForGen: (gen: number) => string,
  lineWidth: number,
  alpha: number,
  segBuf: Seg[],
  scratch: HTMLCanvasElement,
) {
  const lo = Math.max(1, firstGen);
  const hi = lastGen;
  if (lo > hi) return;

  ctx.save();
  ctx.translate(originX, originY);

  for (let g = lo; g <= hi; g++) {
    const mask = maskAt(g);
    const prev = maskAt(g - 1);
    if (!mask || !prev) continue;
    paintRippleRing(ctx, mask, prev, cw, ch, cell, 0, 0, ringFill, alpha, scratch);
  }

  for (let g = lo; g <= hi; g++) {
    const mask = maskAt(g);
    if (!mask) continue;
    strokeContourLoops(
      ctx,
      extractMaskLoops(mask, cw, ch, cell, segBuf),
      strokeForGen(g),
      lineWidth,
      alpha,
    );
  }

  ctx.restore();
}

/**
 * Cavalry: Shape1…ShapeN — кольца залиты фоном, все обводки поверх (36Days).
 */
export function drawContourGenerationStack(
  ctx: CanvasRenderingContext2D,
  masks: Uint8Array[],
  firstGen: number,
  lastGen: number,
  cw: number,
  ch: number,
  cell: number,
  originX: number,
  originY: number,
  fill: string | null,
  stroke: string,
  lineWidth: number,
  alpha: number,
  segBuf: Seg[],
  scratch: HTMLCanvasElement,
) {
  const lo = Math.max(1, firstGen);
  const hi = Math.min(lastGen, masks.length - 1);
  if (lo > hi) return;

  ctx.save();
  ctx.translate(originX, originY);

  for (let g = lo; g <= hi; g++) {
    const mask = masks[g];
    const prev = masks[g - 1];
    if (!mask || !prev) continue;
    paintRippleRing(ctx, mask, prev, cw, ch, cell, 0, 0, fill, alpha, scratch);
  }

  for (let g = lo; g <= hi; g++) {
    const mask = masks[g];
    if (!mask) continue;
    strokeContourLoops(ctx, extractMaskLoops(mask, cw, ch, cell, segBuf), stroke, lineWidth, alpha);
  }

  ctx.restore();
}

/**
 * Слой референса: заливка всей формы фоном + обводка.
 * Внешний слой перекрывает внутренние — видны только линии, как в 36Days.
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
  scratch: HTMLCanvasElement,
) {
  const pw = Math.ceil(cw * cell);
  const ph = Math.ceil(ch * cell);
  if (scratch.width !== cw || scratch.height !== ch) {
    scratch.width = cw;
    scratch.height = ch;
  }
  const octx = scratch.getContext('2d');
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
    ctx.drawImage(scratch, 0, 0, cw, ch, 0, 0, pw, ph);
    ctx.globalCompositeOperation = 'source-over';
  } else {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(scratch, 0, 0, cw, ch, 0, 0, pw, ph);
    ctx.globalCompositeOperation = 'source-over';
  }

  strokeContourLoops(ctx, extractMaskLoops(mask, cw, ch, cell, segBuf), stroke, lineWidth, 1);
  ctx.restore();
}

/** Круговое расширение маски на radiusCells (один шаг offset). */
export function dilateMaskInto(
  prev: Uint8Array,
  out: Uint8Array,
  cw: number,
  ch: number,
  radiusCells: number,
) {
  const r = Math.max(1, Math.round(radiusCells));
  const r2 = r * r;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let on = 0;
      for (let dy = -r; dy <= r && !on; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= ch) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r2) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= cw) continue;
          if (prev[yy * cw + xx]) {
            on = 1;
            break;
          }
        }
      }
      out[y * cw + x] = on;
    }
  }
}

/** Offset: расширение только предыдущей формы (не оригинала). */
export function offsetMaskInto(
  prev: Uint8Array,
  out: Uint8Array,
  cw: number,
  ch: number,
  radiusCells: number,
  distBuf: Float32Array,
) {
  dilateMaskInto(prev, out, cw, ch, radiusCells);
  void distBuf;
}

function boxBlurMask(
  mask: Uint8Array,
  cw: number,
  ch: number,
  kernel: number,
  out: Float32Array,
) {
  const k = Math.max(1, Math.min(3, Math.round(kernel)));
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -k; dy <= k; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= ch) continue;
        for (let dx = -k; dx <= k; dx++) {
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

/** Smooth: сглаживание текущей формы (после offset). */
export function smoothMask(
  mask: Uint8Array,
  cw: number,
  ch: number,
  passes: number,
  threshold: number,
  kernel: number,
  bufA?: Uint8Array,
  bufB?: Uint8Array,
): Uint8Array {
  const a = bufA ?? new Uint8Array(mask.length);
  const b = bufB ?? new Uint8Array(mask.length);
  const blur = new Float32Array(mask.length);
  let cur: Uint8Array = mask;
  let out = a;

  const nPass = Math.max(1, passes);
  for (let p = 0; p < nPass; p++) {
    boxBlurMask(cur, cw, ch, kernel, blur);
    for (let i = 0; i < mask.length; i++) out[i] = blur[i]! >= threshold ? 1 : 0;
    cur = out;
    out = cur === a ? b : a;
  }

  return new Uint8Array(cur);
}

function smoothParamsForStep(stepIndex: number, p: ShapeStepParams) {
  const d = stepIndex - p.smoothFromStep;
  if (d <= 0) return { passes: 1, kernel: 1, threshold: 0.42 };
  const passes = Math.min(
    8,
    p.baseSmoothPasses + Math.floor(d * (0.05 + p.waveFlatten * 0.18)),
  );
  const kernel = 1 + Math.min(3, Math.floor(d / 4));
  const threshold = p.baseThreshold - Math.min(0.1, d * 0.0035 * (0.35 + p.waveFlatten));
  return { passes, kernel, threshold };
}

/** Shapeₙ = Smooth(Offset(Shapeₙ₋₁)); stepIndex = n. */
export function expandShapeStep(
  prev: Uint8Array,
  cw: number,
  ch: number,
  stepIndex: number,
  params: ShapeStepParams,
  distBuf: Float32Array,
  offsetBuf: Uint8Array,
  smoothA: Uint8Array,
  smoothB: Uint8Array,
): Uint8Array {
  offsetMaskInto(prev, offsetBuf, cw, ch, params.radiusCells, distBuf);
  if (stepIndex < params.smoothFromStep) {
    return new Uint8Array(offsetBuf);
  }
  const sp = smoothParamsForStep(stepIndex, params);
  return smoothMask(offsetBuf, cw, ch, sp.passes, sp.threshold, sp.kernel, smoothA, smoothB);
}

export type ContourChain = {
  masks: Uint8Array[];
  loops: Pt[][][];
  cw: number;
  ch: number;
  cell: number;
  originX: number;
  originY: number;
};

/**
 * Цепочка Shape0 → Shape1 → … ; каждый следующий только из предыдущего.
 * Shape0 = растр исходного текста (один раз).
 */
export function buildContourChain(
  glyphMask: Uint8Array,
  cw: number,
  ch: number,
  cell: number,
  count: number,
  params: ShapeStepParams,
  segBuf: Seg[],
): ContourChain {
  const n = Math.max(1, Math.min(150, Math.round(count)));
  const masks: Uint8Array[] = [];
  const loops: Pt[][][] = [];

  const distBuf = new Float32Array(glyphMask.length);
  const offsetBuf = new Uint8Array(glyphMask.length);
  const smoothA = new Uint8Array(glyphMask.length);
  const smoothB = new Uint8Array(glyphMask.length);

  let cur = new Uint8Array(glyphMask);
  masks.push(cur);
  loops.push(extractMaskLoops(cur, cw, ch, cell, segBuf));

  for (let i = 1; i < n; i++) {
    cur = expandShapeStep(cur, cw, ch, i, params, distBuf, offsetBuf, smoothA, smoothB);
    masks.push(new Uint8Array(cur));
    loops.push(extractMaskLoops(cur, cw, ch, cell, segBuf));
  }

  return { masks, loops, cw, ch, cell, originX: 0, originY: 0 };
}

function appendLoop(ctx: CanvasRenderingContext2D, loop: Pt[]) {
  ctx.moveTo(loop[0]!.x, loop[0]!.y);
  for (let i = 1; i < loop.length; i++) ctx.lineTo(loop[i]!.x, loop[i]!.y);
  ctx.closePath();
}

function paintMaskRegion(
  ctx: CanvasRenderingContext2D,
  mask: Uint8Array,
  prevMask: Uint8Array | null,
  cw: number,
  ch: number,
  cell: number,
  originX: number,
  originY: number,
  fill: string | null,
  alpha: number,
  scratch: HTMLCanvasElement,
) {
  const pw = Math.ceil(cw * cell);
  const ph = Math.ceil(ch * cell);
  if (scratch.width !== cw || scratch.height !== ch) {
    scratch.width = cw;
    scratch.height = ch;
  }
  const octx = scratch.getContext('2d');
  if (!octx) return;

  const img = octx.createImageData(cw, ch);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    if (prevMask && prevMask[i]) continue;
    const p = i * 4;
    img.data[p] = 255;
    img.data[p + 1] = 255;
    img.data[p + 2] = 255;
    img.data[p + 3] = 255;
  }
  octx.putImageData(img, 0, 0);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scratch, 0, 0, cw, ch, originX, originY, pw, ph);
  if (fill) {
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = fill;
    ctx.fillRect(originX, originY, pw, ph);
  } else {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,1)';
    ctx.fillRect(originX, originY, pw, ph);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

/** Заливка кольца Shapeₙ \\ Shapeₙ₋₁ цветом фона (скрывает «задние» линии). */
export function paintRippleRing(
  ctx: CanvasRenderingContext2D,
  mask: Uint8Array,
  prevMask: Uint8Array,
  cw: number,
  ch: number,
  cell: number,
  originX: number,
  originY: number,
  fill: string | null,
  alpha: number,
  scratch: HTMLCanvasElement,
) {
  paintMaskRegion(ctx, mask, prevMask, cw, ch, cell, originX, originY, fill, alpha, scratch);
}

/**
 * Референс 36Days: сначала все кольца залиты фоном, затем все обводки поверх —
 * так видны все вложенные линии одновременно.
 */
export function drawRippleStack(
  ctx: CanvasRenderingContext2D,
  masks: Uint8Array[],
  loops: Pt[][][],
  cw: number,
  ch: number,
  cell: number,
  originX: number,
  originY: number,
  waveCount: number,
  fill: string | null,
  stroke: string,
  lineWidth: number,
  alpha: number,
  scratch: HTMLCanvasElement,
) {
  const n = Math.min(waveCount, masks.length - 1);
  for (let wave = 1; wave <= n; wave++) {
    paintRippleRing(
      ctx,
      masks[wave]!,
      masks[wave - 1]!,
      cw,
      ch,
      cell,
      originX,
      originY,
      fill,
      alpha,
      scratch,
    );
  }
  for (let wave = 1; wave <= n; wave++) {
    strokeContourLoops(ctx, loops[wave] ?? [], stroke, lineWidth, alpha);
  }
}

/** Заливка всей формы цветом фона + обводка контура (Shapeₙ). */
export function drawShapeLayer(
  ctx: CanvasRenderingContext2D,
  mask: Uint8Array,
  loops: Pt[][],
  cw: number,
  ch: number,
  cell: number,
  fill: string | null,
  stroke: string,
  lineWidth: number,
  alpha: number,
  scratch: HTMLCanvasElement,
) {
  paintMaskFull(ctx, mask, cw, ch, cell, fill, alpha, scratch);
  strokeContourLoops(ctx, loops, stroke, lineWidth, alpha);
}

function paintMaskFull(
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
  if (scratch.width !== cw || scratch.height !== ch) {
    scratch.width = cw;
    scratch.height = ch;
  }
  const octx = scratch.getContext('2d');
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
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(scratch, 0, 0, cw, ch, 0, 0, pw, ph);
  if (fill) {
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, pw, ph);
  } else {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,1)';
    ctx.fillRect(0, 0, pw, ph);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

/** Только обводка контура — каждая волна отдельной линией на фоне. */
export function strokeContourLoops(
  ctx: CanvasRenderingContext2D,
  loops: Pt[][],
  stroke: string,
  lineWidth: number,
  alpha: number,
) {
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

