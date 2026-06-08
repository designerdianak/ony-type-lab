import gsap from 'gsap';
import type { Paths } from 'js-angusj-clipper';
import {
  colorForGlyph,
  gradientAt,
  mulberry32,
  randomVividPalette,
} from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { fillGlyphPath } from '../utils/opentypeCanvas';
import { layoutTextForCanvas, type GlyphLayout } from '../utils/textLayout';
import {
  buildTextSilhouette,
  getVectorClipper,
  initVectorClipper,
  pathsBoundsCenter,
  pathsToPath2D,
} from '../utils/vectorOffset';
import { resolveElasticGradientFill } from '../types/playground';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

type Lay = { char: string; x: number; bl: number };

type LineExtrusion = {
  path2D: Path2D;
  anchor: { cx: number; cy: number };
  lays: Lay[];
};

type MaskStep = { count: number; stx: number; sty: number };

const TRAIL_EXTENT_CAP = 56;
const CHOPPY_BANDS = 12;
const MASK_FEATHER_PX = 0.7;

function canvasDpr(w: number, canvas: HTMLCanvasElement): number {
  return canvas.width / Math.max(1, w);
}

function groupGlyphsByLine(glyphs: GlyphLayout[], fontSize: number): GlyphLayout[][] {
  const thresh = fontSize * 0.45;
  const lines: GlyphLayout[][] = [];
  for (const g of glyphs) {
    const row = lines.find((line) => Math.abs(line[0]!.baseline - g.baseline) < thresh);
    if (row) row.push(g);
    else lines.push([g]);
  }
  return lines.sort((a, b) => a[0]!.baseline - b[0]!.baseline);
}

function maskStep(extent: number, tx: number, ty: number, fontSize: number): MaskStep {
  const vx = tx * extent;
  const vy = ty * extent;
  const trailLen = Math.hypot(vx, vy) || 1;
  const unit = Math.hypot(tx, ty) || 0.35;
  const overlapPx = Math.max(unit * 0.22, fontSize * 0.014);
  const count = Math.min(48, Math.max(18, Math.ceil(trailLen / overlapPx)));
  return { count, stx: vx / count, sty: vy / count };
}

export function createGradientFlowMode(
  _canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let layoutSig = '';
  let settingsSig = '';
  let tickerFn: (() => void) | null = null;
  let flowPhase = 0;
  let clipperReady = false;

  let layoutFontSize = 72;
  let lines: LineExtrusion[] = [];
  let surfaceW = 0;
  let surfaceH = 0;

  const trailLayer = document.createElement('canvas');
  const trailCtx = trailLayer.getContext('2d', { alpha: true });
  let trailKey = '';
  let trailReady = false;

  const textLayer = document.createElement('canvas');
  const textCtx = textLayer.getContext('2d', { alpha: true });
  let textKey = '';
  let textReady = false;

  let trailMaskSig = '';
  const lineMasks: HTMLCanvasElement[] = [];
  let choppyPaletteCache = '';
  let choppyPaletteColors: string[] = [];

  function choppyPalette(s: ModeSnapshot): string[] {
    const seed = String(s.visual.rainbowSeed);
    if (seed !== choppyPaletteCache) {
      choppyPaletteCache = seed;
      const rng = mulberry32(Math.floor(s.visual.rainbowSeed * 1000));
      choppyPaletteColors = randomVividPalette(rng() * 1000, 6);
    }
    return choppyPaletteColors;
  }

  function smoothPalette(s: ModeSnapshot): string[] {
    const e = s.visual.elastic;
    const custom = e.smoothColors;
    if (custom && custom.length >= 2) return custom;
    return [e.colorA, e.colorB, e.colorC];
  }

  function rebuildLines(s: ModeSnapshot) {
    lines = [];
    const { w, h } = { w: Math.max(1, Math.round(s.w)), h: Math.max(1, Math.round(s.h)) };
    const block = layoutTextForCanvas(
      ctx,
      s.text,
      s.fontCss,
      s.fontSize,
      s.letterSpacing,
      w,
      h,
      s.lineHeight,
    );
    layoutFontSize = block.effectiveFontSize;

    const clipper = getVectorClipper();
    if (!clipper || !s.opentypeFont) return;

    const rows = groupGlyphsByLine(block.glyphs, layoutFontSize);
    for (const row of rows) {
      const lays: Lay[] = row.map((g) => ({ char: g.char, x: g.x, bl: g.baseline }));
      const shape: Paths = buildTextSilhouette(clipper, s.opentypeFont, lays, layoutFontSize);
      if (!shape.length) continue;

      lines.push({
        path2D: pathsToPath2D(shape),
        anchor: pathsBoundsCenter(shape),
        lays,
      });
    }
  }

  function elasticSig(s: ModeSnapshot): string {
    const e = s.visual.elastic;
    return [
      e.flowLength,
      e.directionDeg,
      e.stepSize,
      e.flowSpeed,
      resolveElasticGradientFill(e),
      (e.smoothColors ?? []).join(','),
      e.colorA,
      e.colorB,
      e.colorC,
      s.visual.rainbowSeed,
      s.visual.colorMode,
    ].join('|');
  }

  function invalidateTrailMasks() {
    trailMaskSig = '';
    lineMasks.length = 0;
  }

  function ensureLayout(s: ModeSnapshot) {
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.lineHeight}|${s.w}|${s.h}|${s.fontUrl}`;
    const es = elasticSig(s);
    if (sig !== layoutSig) {
      layoutSig = sig;
      settingsSig = es;
      trailKey = '';
      trailReady = false;
      textKey = '';
      textReady = false;
      flowPhase = 0;
      invalidateTrailMasks();
      rebuildLines(s);
    } else if (es !== settingsSig) {
      settingsSig = es;
      trailKey = '';
      trailReady = false;
      textKey = '';
      textReady = false;
      invalidateTrailMasks();
    } else if (clipperReady && lines.length === 0 && s.opentypeFont) {
      rebuildLines(s);
    }
  }

  function trailStep(s: ModeSnapshot): { tx: number; ty: number } {
    const e = s.visual.elastic;
    const deg = ((e.directionDeg % 360) + 360) % 360;
    const rad = (deg * Math.PI) / 180;
    const stepPx = Math.max(0.35, e.stepSize * layoutFontSize * 0.032);
    return {
      tx: Math.cos(rad) * stepPx,
      ty: Math.sin(rad) * stepPx,
    };
  }

  function extentLayers(s: ModeSnapshot): number {
    const e = s.visual.elastic;
    const raw = Math.round(e.flowLength * 2.8);
    return Math.min(TRAIL_EXTENT_CAP, Math.max(2, raw));
  }

  function ensureSurface(w: number, h: number) {
    if (surfaceW === w && surfaceH === h && trailLayer.width > 0) return;
    surfaceW = w;
    surfaceH = h;
    const dpr = canvasDpr(w, ctx.canvas);
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    for (const layer of [trailLayer, textLayer]) {
      if (layer.width !== pw) layer.width = pw;
      if (layer.height !== ph) layer.height = ph;
    }
    trailCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    textCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function blitLayer(layer: HTMLCanvasElement, w: number, h: number) {
    const dpr = canvasDpr(w, ctx.canvas);
    ctx.drawImage(layer, 0, 0, layer.width, layer.height, 0, 0, w * dpr, h * dpr);
  }

  function featherMask(raw: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
    const out = document.createElement('canvas');
    out.width = raw.width;
    out.height = raw.height;
    const outCtx = out.getContext('2d');
    if (!outCtx) return raw;
    const dpr = canvasDpr(w, ctx.canvas);
    outCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    outCtx.filter = `blur(${MASK_FEATHER_PX}px)`;
    outCtx.drawImage(raw, 0, 0, raw.width, raw.height, 0, 0, w, h);
    outCtx.filter = 'none';
    return out;
  }

  function ensureTrailMasks(
    extent: number,
    baseTx: number,
    baseTy: number,
    w: number,
    h: number,
  ) {
    const step = maskStep(extent, baseTx, baseTy, layoutFontSize);
    const sig = `${layoutSig}|${extent}|${baseTx}|${baseTy}|${step.count}|${w}|${h}`;
    if (sig === trailMaskSig && lineMasks.length === lines.length) return;

    trailMaskSig = sig;
    lineMasks.length = 0;

    const dpr = canvasDpr(w, ctx.canvas);
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));

    for (const line of lines) {
      const raw = document.createElement('canvas');
      raw.width = pw;
      raw.height = ph;
      const rawCtx = raw.getContext('2d');
      if (!rawCtx) continue;

      rawCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      rawCtx.fillStyle = '#fff';
      for (let i = 1; i <= step.count; i++) {
        rawCtx.save();
        rawCtx.translate(line.anchor.cx + step.stx * i, line.anchor.cy + step.sty * i);
        rawCtx.translate(-line.anchor.cx, -line.anchor.cy);
        rawCtx.fill(line.path2D, 'evenodd');
        rawCtx.restore();
      }
      lineMasks.push(featherMask(raw, w, h));
    }
  }

  function trailGradient(
    target: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    dirX: number,
    dirY: number,
    trailLen: number,
    phase: number,
    pal: string[],
    choppy: boolean,
  ): CanvasGradient {
    const shift = phase * trailLen;
    const span = trailLen * (choppy ? 1 : 1.35);
    const gx0 = cx - dirX * shift - dirX * trailLen * 0.08;
    const gy0 = cy - dirY * shift - dirY * trailLen * 0.08;
    const gx1 = gx0 + dirX * span;
    const gy1 = gy0 + dirY * span;
    const grad = target.createLinearGradient(gx0, gy0, gx1, gy1);

    if (choppy) {
      for (let b = 0; b < CHOPPY_BANDS; b++) {
        const t = ((b + 0.5) / CHOPPY_BANDS + phase) % 1;
        const color = gradientAt(pal, t);
        grad.addColorStop(b / CHOPPY_BANDS, color);
        grad.addColorStop((b + 1) / CHOPPY_BANDS, color);
      }
    } else if (pal.length <= 1) {
      const c = pal[0] ?? '#000';
      grad.addColorStop(0, c);
      grad.addColorStop(1, c);
    } else if (pal.length === 2) {
      grad.addColorStop(0, pal[0]!);
      grad.addColorStop(0.5, pal[1]!);
      grad.addColorStop(1, pal[0]!);
    } else {
      const n = pal.length - 1;
      for (let i = 0; i < pal.length; i++) {
        grad.addColorStop(i / n, pal[i]!);
      }
    }
    return grad;
  }

  function paintTrailMasked(
    s: ModeSnapshot,
    phase: number,
    alpha: number,
    extent: number,
    baseTx: number,
    baseTy: number,
    w: number,
    h: number,
    choppy: boolean,
  ) {
    if (!trailCtx) return;

    ensureTrailMasks(extent, baseTx, baseTy, w, h);

    const trailLen = Math.hypot(baseTx * extent, baseTy * extent) || 1;
    const dirX = (baseTx * extent) / trailLen;
    const dirY = (baseTy * extent) / trailLen;
    const pal = choppy ? choppyPalette(s) : smoothPalette(s);

    trailCtx.save();
    trailCtx.beginPath();
    trailCtx.rect(0, 0, w, h);
    trailCtx.clip();
    trailCtx.globalAlpha = alpha;

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]!;
      const mask = lineMasks[li];
      if (!mask) continue;

      trailCtx.globalCompositeOperation = 'source-over';
      trailCtx.fillStyle = trailGradient(
        trailCtx,
        line.anchor.cx,
        line.anchor.cy,
        dirX,
        dirY,
        trailLen,
        phase,
        pal,
        choppy,
      );
      trailCtx.fillRect(0, 0, w, h);
      trailCtx.globalCompositeOperation = 'destination-in';
      trailCtx.drawImage(mask, 0, 0, mask.width, mask.height, 0, 0, w, h);
    }

    trailCtx.globalCompositeOperation = 'source-over';
    trailCtx.restore();
  }

  function paintTrail(s: ModeSnapshot, phase: number, alpha: number, w: number, h: number, animating: boolean) {
    const e = s.visual.elastic;
    const fillMode = resolveElasticGradientFill(e);
    const choppy = fillMode === 'choppy';
    const extent = extentLayers(s);
    const { tx, ty } = trailStep(s);

    if (!animating && trailReady && trailLayer.width > 0) {
      const pal = choppy ? choppyPalette(s) : smoothPalette(s);
      const key = `${layoutSig}|${fillMode}|${extent}|${e.directionDeg}|${e.stepSize}|${pal.join(',')}|${phase.toFixed(3)}|${alpha}`;
      if (key === trailKey) return;
      trailKey = key;
    } else if (!animating) {
      trailKey = '';
    }

    if (!trailCtx) return;
    trailReady = !animating;

    ensureSurface(w, h);
    trailCtx.clearRect(0, 0, w, h);
    paintTrailMasked(s, phase, alpha, extent, tx, ty, w, h, choppy);
  }

  function paintText(s: ModeSnapshot, alpha: number, w: number, h: number) {
    const key = `${layoutSig}|${s.visual.monochromeColor}|${alpha}|${s.visual.colorMode}`;
    if (textReady && key === textKey && textLayer.width > 0) {
      blitLayer(textLayer, w, h);
      return;
    }
    if (!textCtx || !s.opentypeFont) return;

    textKey = key;
    textReady = true;
    ensureSurface(w, h);
    textCtx.clearRect(0, 0, w, h);
    textCtx.save();
    textCtx.globalAlpha = alpha;

    for (const line of lines) {
      for (const g of line.lays) {
        const fill = colorForGlyph({
          mode: s.visual.colorMode,
          monochrome: s.visual.monochromeColor,
          seed: s.visual.rainbowSeed,
          index: g.char.charCodeAt(0),
          total: line.lays.length,
        });
        fillGlyphPath(textCtx, s.opentypeFont.getPath(g.char, g.x, g.bl, layoutFontSize), fill);
      }
    }
    textCtx.restore();
    blitLayer(textLayer, w, h);
  }

  function tick() {
    const s = getSnap();
    const w = Math.max(1, Math.round(s.w));
    const h = Math.max(1, Math.round(s.h));

    ensureLayout(s);

    const alpha = effectOpacity(s.visual);
    const animating = s.visual.animationEnabled && !s.visual.sceneFrozen && lines.length > 0;

    if (animating) {
      const speed = s.visual.elastic.flowSpeed ?? 0.45;
      flowPhase += speed * (gsap.ticker.deltaRatio() / 60);
      if (!Number.isFinite(flowPhase)) flowPhase = 0;
    }

    clearNeutral(ctx, w, h, s.visual.stageBackground);
    applyMultiplyBlend(ctx, s.visual.multiplyBlend);

    if (lines.length > 0) {
      paintTrail(s, flowPhase, alpha, w, h, animating);
      if (trailLayer.width > 0) blitLayer(trailLayer, w, h);
      paintText(s, alpha, w, h);
    }
  }

  return {
    start() {
      layoutSig = '';
      clipperReady = false;
      flowPhase = 0;
      surfaceW = 0;
      surfaceH = 0;
      trailKey = '';
      trailReady = false;
      textKey = '';
      textReady = false;
      choppyPaletteCache = '';
      lines = [];
      invalidateTrailMasks();

      initVectorClipper()
        .then(() => {
          clipperReady = true;
          rebuildLines(getSnap());
        })
        .catch((err) => console.error('[Flow] clipper load failed', err));

      tickerFn = () => tick();
      gsap.ticker.add(tickerFn);
    },
    stop() {
      if (tickerFn) gsap.ticker.remove(tickerFn);
      tickerFn = null;
    },
    dispose() {
      this.stop();
    },
    interruptInteraction() {},
  };
}
