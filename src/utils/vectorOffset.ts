import type opentype from 'opentype.js';
import {
  ClipType,
  EndType,
  JoinType,
  loadNativeClipperLibInstanceAsync,
  NativeClipperLibRequestedFormat,
  PolyFillType,
  type ClipperLibWrapper,
  type IntPoint,
  type Path,
  type Paths,
} from 'js-angusj-clipper';

export const CLIPPER_SCALE = 64;

type XY = { x: number; y: number };

let clipperLib: ClipperLibWrapper | null = null;
let clipperLoad: Promise<ClipperLibWrapper> | null = null;

export function initVectorClipper(): Promise<ClipperLibWrapper> {
  if (clipperLib) return Promise.resolve(clipperLib);
  if (!clipperLoad) {
    clipperLoad = loadNativeClipperLibInstanceAsync(
      NativeClipperLibRequestedFormat.WasmWithAsmJsFallback,
    ).then((lib) => {
      clipperLib = lib;
      return lib;
    });
  }
  return clipperLoad;
}

export function getVectorClipper(): ClipperLibWrapper | null {
  return clipperLib;
}

function toInt(x: number, y: number): IntPoint {
  return { x: Math.round(x * CLIPPER_SCALE), y: Math.round(y * CLIPPER_SCALE) };
}

function fromInt(p: IntPoint): XY {
  return { x: p.x / CLIPPER_SCALE, y: p.y / CLIPPER_SCALE };
}

function dist2(a: XY, b: XY): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function flattenQuad(p0: XY, p1: XY, p2: XY, tol2: number, out: XY[]) {
  const mid = { x: (p0.x + p2.x) * 0.5, y: (p0.y + p2.y) * 0.5 };
  if (dist2(p0, p2) <= tol2) {
    out.push(p2);
    return;
  }
  flattenQuad(p0, { x: (p0.x + p1.x) * 0.5, y: (p0.y + p1.y) * 0.5 }, mid, tol2, out);
  flattenQuad(mid, { x: (p1.x + p2.x) * 0.5, y: (p1.y + p2.y) * 0.5 }, p2, tol2, out);
}

function flattenCubic(p0: XY, p1: XY, p2: XY, p3: XY, tol2: number, out: XY[]) {
  if (dist2(p0, p3) <= tol2) {
    out.push(p3);
    return;
  }
  const a = { x: (p0.x + p1.x) * 0.5, y: (p0.y + p1.y) * 0.5 };
  const b = { x: (p1.x + p2.x) * 0.5, y: (p1.y + p2.y) * 0.5 };
  const c = { x: (p2.x + p3.x) * 0.5, y: (p2.y + p3.y) * 0.5 };
  const d = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
  const e = { x: (b.x + c.x) * 0.5, y: (b.y + c.y) * 0.5 };
  const f = { x: (d.x + e.x) * 0.5, y: (d.y + e.y) * 0.5 };
  flattenCubic(p0, a, d, f, tol2, out);
  flattenCubic(f, e, c, p3, tol2, out);
}

/** Разбивает opentype Path на замкнутые контуры (полигоны). */
export function opentypePathToPolygons(path: opentype.Path, tolerance = 0.4): XY[][] {
  const tol2 = tolerance * tolerance;
  const contours: XY[][] = [];
  let cur: XY[] = [];
  let pen: XY = { x: 0, y: 0 };

  const closeContour = () => {
    if (cur.length >= 3) contours.push(cur);
    cur = [];
  };

  for (const cmd of path.commands) {
    switch (cmd.type) {
      case 'M':
        closeContour();
        pen = { x: cmd.x, y: cmd.y };
        cur = [pen];
        break;
      case 'L': {
        const p = { x: cmd.x, y: cmd.y };
        cur.push(p);
        pen = p;
        break;
      }
      case 'Q': {
        const p2 = { x: cmd.x, y: cmd.y };
        const p1 = { x: cmd.x1, y: cmd.y1 };
        flattenQuad(pen, p1, p2, tol2, cur);
        pen = p2;
        break;
      }
      case 'C': {
        const p3 = { x: cmd.x, y: cmd.y };
        const p1 = { x: cmd.x1, y: cmd.y1 };
        const p2 = { x: cmd.x2, y: cmd.y2 };
        flattenCubic(pen, p1, p2, p3, tol2, cur);
        pen = p3;
        break;
      }
      case 'Z':
        closeContour();
        break;
      default:
        break;
    }
  }
  closeContour();
  return contours;
}

function xyPolyToPath(poly: XY[]): Path {
  const out: Path = [];
  for (const p of poly) {
    if (out.length > 0) {
      const prev = out[out.length - 1]!;
      if (prev.x === Math.round(p.x * CLIPPER_SCALE) && prev.y === Math.round(p.y * CLIPPER_SCALE)) {
        continue;
      }
    }
    out.push(toInt(p.x, p.y));
  }
  return out.length >= 3 ? out : [];
}

export function shapeMaxRadius(paths: Paths, center: { cx: number; cy: number }): number {
  let maxR = 0;
  for (const path of paths) {
    for (const p of path) {
      const x = p.x / CLIPPER_SCALE;
      const y = p.y / CLIPPER_SCALE;
      maxR = Math.max(maxR, Math.hypot(x - center.cx, y - center.cy));
    }
  }
  return maxR;
}

export function pathsBoundsCenter(paths: Paths): { cx: number; cy: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of paths) {
    for (const p of path) {
      const x = p.x / CLIPPER_SCALE;
      const y = p.y / CLIPPER_SCALE;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { cx: (minX + maxX) * 0.5, cy: (minY + maxY) * 0.5 };
}

export function translatePaths(paths: Paths, dxPx: number, dyPx: number): Paths {
  if (dxPx === 0 && dyPx === 0) return paths;
  const dx = Math.round(dxPx * CLIPPER_SCALE);
  const dy = Math.round(dyPx * CLIPPER_SCALE);
  return paths.map((path) => path.map((p) => ({ x: p.x + dx, y: p.y + dy })));
}

/** Силуэт всего слова — union контуров букв (Shape0). */
export function buildTextSilhouette(
  clipper: ClipperLibWrapper,
  font: opentype.Font,
  lays: { char: string; x: number; bl: number }[],
  fontSize: number,
): Paths {
  const raw: Path[] = [];
  for (const g of lays) {
    const polys = opentypePathToPolygons(font.getPath(g.char, g.x, g.bl, fontSize));
    for (const poly of polys) {
      const path = xyPolyToPath(poly);
      if (path.length >= 3) raw.push(path);
    }
  }
  if (raw.length === 0) return [];
  if (raw.length === 1) return raw;

  return clipper.clipToPaths({
    clipType: ClipType.Union,
    subjectFillType: PolyFillType.NonZero,
    subjectInputs: raw.map((data) => ({ data, closed: true })),
  });
}

/** Shapeₙ = Offset(Shapeₙ₋₁) — равномерный векторный offset (Clipper). */
export function offsetPaths(
  clipper: ClipperLibWrapper,
  prev: Paths,
  deltaPx: number,
): Paths {
  if (prev.length === 0 || deltaPx <= 0) return [];

  const result = clipper.offsetToPaths({
    delta: deltaPx * CLIPPER_SCALE,
    arcTolerance: 0.35 * CLIPPER_SCALE,
    offsetInputs: [
      {
        joinType: JoinType.Round,
        endType: EndType.ClosedPolygon,
        data: prev,
      },
    ],
  });

  return result?.length ? result : [];
}

/**
 * Offset + сдвиг позиции кольца по bias (текст не двигается).
 * bias ∈ [-1, 1] — направление накопительного смещения контуров.
 */
export function offsetPathsWithBias(
  clipper: ClipperLibWrapper,
  prev: Paths,
  deltaPx: number,
  biasX: number,
  biasY: number,
  biasShift: number,
): Paths {
  const result = offsetPaths(clipper, prev, deltaPx);
  if (!result.length) return [];

  const bx = Math.max(-1, Math.min(1, biasX));
  const by = Math.max(-1, Math.min(1, biasY));
  if (bx === 0 && by === 0) return result;

  return translatePaths(result, bx * deltaPx * biasShift, by * deltaPx * biasShift);
}

export function pathsToPath2D(paths: Paths): Path2D {
  const p = new Path2D();
  for (const path of paths) {
    if (path.length < 2) continue;
    const first = fromInt(path[0]!);
    p.moveTo(first.x, first.y);
    for (let i = 1; i < path.length; i++) {
      const pt = fromInt(path[i]!);
      p.lineTo(pt.x, pt.y);
    }
    p.closePath();
  }
  return p;
}

function withTranslate(ctx: CanvasRenderingContext2D, dx: number, dy: number, draw: () => void) {
  ctx.save();
  if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) ctx.translate(dx, dy);
  draw();
  ctx.restore();
}

function fillRingPath2D(
  ctx: CanvasRenderingContext2D,
  outer: Path2D,
  inner: Path2D,
  dx: number,
  dy: number,
  fill: string | null,
  alpha: number,
) {
  if (!fill) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  withTranslate(ctx, dx, dy, () => {
    ctx.fillStyle = fill;
    ctx.fill(outer, 'evenodd');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fill(inner, 'evenodd');
    ctx.globalCompositeOperation = 'source-over';
  });
  ctx.restore();
}

function fillSolidPath2D(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  dx: number,
  dy: number,
  fill: string,
  alpha: number,
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = fill;
  withTranslate(ctx, dx, dy, () => {
    ctx.fill(path, 'evenodd');
  });
  ctx.restore();
}

function strokePath2D(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  dx: number,
  dy: number,
  stroke: string,
  lineWidth: number,
  alpha: number,
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  withTranslate(ctx, dx, dy, () => {
    ctx.stroke(path);
  });
  ctx.restore();
}

/** Плавное затухание на стыке цикла — убирает рывок при wrap. */
function flowLayerOpacity(frac: number, edge = 0.14): number {
  if (frac < edge) return frac / edge;
  if (frac > 1 - edge) return (1 - frac) / edge;
  return 1;
}

function fillRingPaths(
  ctx: CanvasRenderingContext2D,
  outer: Paths,
  inner: Paths,
  fill: string | null,
  alpha: number,
) {
  if (!fill || outer.length === 0) return;
  fillRingPath2D(ctx, pathsToPath2D(outer), pathsToPath2D(inner), 0, 0, fill, alpha);
}

function strokePaths(
  ctx: CanvasRenderingContext2D,
  paths: Paths,
  stroke: string,
  lineWidth: number,
  alpha: number,
) {
  if (paths.length === 0) return;
  strokePath2D(ctx, pathsToPath2D(paths), 0, 0, stroke, lineWidth, alpha);
}

export type RippleDrawStyle = 'ring' | 'solid';

const SHELL_GEN = 1;

/** Фаза сдвига для gen-го слоя (волна от оболочки наружу). */
function flowFrac(phase: number, gen: number, flowCount: number): number {
  const t = phase - (gen - SHELL_GEN) / flowCount;
  return t - Math.floor(t);
}

/**
 * Поток offset-слоёв:
 * — gen=1: зафиксированная оболочка у текста (без сдвига);
 * — gen≥2: плавный translate + fade (без scale).
 */
export function drawVectorRippleCarousel(
  ctx: CanvasRenderingContext2D,
  pathAt: (gen: number) => Path2D | null,
  ringCount: number,
  phase: number,
  drawStyle: RippleDrawStyle,
  ringFillForGen: (outerGen: number) => string | null,
  strokeForGen: ((gen: number) => string) | null,
  lineWidth: number,
  alpha: number,
  stepShift: { x: number; y: number },
) {
  if (ringCount < 1) return;

  const flowCount = Math.max(1, ringCount);
  const shellOuter = pathAt(SHELL_GEN);
  const shellInner = pathAt(0);
  const shellFill = ringFillForGen(SHELL_GEN);

  const drawFlowLayer = (gen: number, layerAlpha: number) => {
    const outer = pathAt(gen);
    const fill = ringFillForGen(gen);
    if (!outer || !fill) return;

    const frac = flowFrac(phase, gen, flowCount);
    const fade = gen === SHELL_GEN ? 1 : flowLayerOpacity(frac);
    const a = alpha * layerAlpha * fade;
    const dx = stepShift.x * frac;
    const dy = stepShift.y * frac;

    if (drawStyle === 'solid') {
      fillSolidPath2D(ctx, outer, dx, dy, fill, a);
      return;
    }

    const inner = pathAt(gen - 1);
    if (!inner) return;
    fillRingPath2D(ctx, outer, inner, dx, dy, fill, a);
  };

  const drawStroke = (gen: number, layerAlpha: number) => {
    if (!strokeForGen) return;
    const outer = pathAt(gen);
    if (!outer) return;
    const frac = gen === SHELL_GEN ? 0 : flowFrac(phase, gen, flowCount);
    const fade = gen === SHELL_GEN ? 1 : flowLayerOpacity(frac);
    const a = alpha * layerAlpha * fade;
    const dx = stepShift.x * frac;
    const dy = stepShift.y * frac;
    strokePath2D(ctx, outer, dx, dy, strokeForGen(gen), lineWidth, a);
  };

  if (drawStyle === 'solid') {
    for (let gen = ringCount; gen > SHELL_GEN; gen--) drawFlowLayer(gen, 1);
    if (shellOuter && shellFill) {
      fillSolidPath2D(ctx, shellOuter, 0, 0, shellFill, alpha);
    }
    return;
  }

  for (let gen = SHELL_GEN + 1; gen <= ringCount; gen++) drawFlowLayer(gen, 1);
  if (shellOuter && shellInner && shellFill) {
    fillRingPath2D(ctx, shellOuter, shellInner, 0, 0, shellFill, alpha);
  }

  if (!strokeForGen) return;
  for (let gen = SHELL_GEN + 1; gen <= ringCount; gen++) drawStroke(gen, 1);
  drawStroke(SHELL_GEN, 1);
}

/**
 * Cavalry: кольца залиты фоном, обводки поверх — векторные контуры.
 */
export function drawVectorRippleStack(
  ctx: CanvasRenderingContext2D,
  shapeAt: (gen: number) => Paths | null,
  firstGen: number,
  lastGen: number,
  ringFill: string | null,
  strokeForGen: (gen: number) => string,
  lineWidth: number,
  alpha: number,
) {
  const lo = Math.max(1, firstGen);
  const hi = lastGen;
  if (lo > hi) return;

  for (let g = lo; g <= hi; g++) {
    const outer = shapeAt(g);
    const inner = shapeAt(g - 1);
    if (!outer?.length || !inner?.length) continue;
    fillRingPaths(ctx, outer, inner, ringFill, alpha);
  }

  for (let g = lo; g <= hi; g++) {
    const outer = shapeAt(g);
    if (!outer?.length) continue;
    strokePaths(ctx, outer, strokeForGen(g), lineWidth, alpha);
  }
}
