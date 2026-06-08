import gsap from 'gsap';
import type { Paths } from 'js-angusj-clipper';
import {
  colorForGlyph,
  gradientAt,
  lerpColor,
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
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

type Lay = { char: string; x: number; bl: number };

type LineExtrusion = {
  path2D: Path2D;
  anchor: { cx: number; cy: number };
  lays: Lay[];
};

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

  const trailLayer = document.createElement('canvas');
  const trailCtx = trailLayer.getContext('2d');
  const maskLayer = document.createElement('canvas');
  const maskCtx = maskLayer.getContext('2d');
  const gradLayer = document.createElement('canvas');
  const gradCtx = gradLayer.getContext('2d');
  let trailKey = '';
  let trailReady = false;

  const textLayer = document.createElement('canvas');
  const textCtx = textLayer.getContext('2d');
  let textKey = '';
  let textReady = false;

  function palette(s: ModeSnapshot): string[] {
    const e = s.visual.elastic;
    if (e.randomGradient) {
      const rng = mulberry32(Math.floor(s.visual.rainbowSeed * 1000));
      return randomVividPalette(rng() * 1000, 6);
    }
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
      e.trailGradientMode ?? 'striped',
      e.randomGradient,
      e.colorA,
      e.colorB,
      e.colorC,
      s.visual.rainbowSeed,
      s.visual.colorMode,
    ].join('|');
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
      rebuildLines(s);
    } else if (es !== settingsSig) {
      settingsSig = es;
      trailKey = '';
      trailReady = false;
      textKey = '';
      textReady = false;
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

  function trailColorAt(s: ModeSnapshot, t: number, smooth: boolean): string {
    const e = s.visual.elastic;
    const pal = palette(s);
    if (e.randomGradient) return gradientAt(pal, t);
    if (s.visual.colorMode === 'rainbow') {
      return colorForGlyph({
        mode: 'rainbow',
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: Math.floor(t * 48),
        total: 48,
      });
    }
    if (smooth) return lerpColor(e.colorA, e.colorB, t);
    return gradientAt([e.colorA, e.colorB, e.colorC], t);
  }

  function fillSmoothGradient(
    target: CanvasRenderingContext2D,
    s: ModeSnapshot,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    phase: number,
    w: number,
    h: number,
  ) {
    const stops = 24;
    const grad = target.createLinearGradient(ax, ay, bx, by);
    for (let i = 0; i <= stops; i++) {
      const pos = i / stops;
      const t = (pos + phase) % 1;
      grad.addColorStop(pos, trailColorAt(s, t, true));
    }
    target.fillStyle = grad;
    target.fillRect(0, 0, w, h);
  }

  function layerCount(s: ModeSnapshot): number {
    const e = s.visual.elastic;
    return Math.max(28, Math.round(e.flowLength * 2.8));
  }

  function setupSurface(layer: HTMLCanvasElement, layerCtx: CanvasRenderingContext2D, w: number, h: number) {
    const dpr = canvasDpr(w, ctx.canvas);
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (layer.width !== pw) layer.width = pw;
    if (layer.height !== ph) layer.height = ph;
    layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return dpr;
  }

  function blitLayer(layer: HTMLCanvasElement, w: number, h: number) {
    const dpr = canvasDpr(w, ctx.canvas);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(layer, 0, 0, layer.width, layer.height, 0, 0, w * dpr, h * dpr);
    ctx.restore();
  }

  function paintTrailStriped(
    s: ModeSnapshot,
    phase: number,
    alpha: number,
    layers: number,
    tx: number,
    ty: number,
  ) {
    const bands = Math.max(6, Math.min(28, Math.round(layers / 3)));

    for (const line of lines) {
      for (let i = layers; i >= 1; i--) {
        const depth = i / layers;
        const tRaw = (depth + phase) % 1;
        const t = Math.floor(tRaw * bands) / bands;
        const fill = trailColorAt(s, t, false);

        trailCtx!.save();
        trailCtx!.globalAlpha = alpha;
        trailCtx!.fillStyle = fill;
        trailCtx!.translate(line.anchor.cx + tx * i, line.anchor.cy + ty * i);
        trailCtx!.translate(-line.anchor.cx, -line.anchor.cy);
        trailCtx!.fill(line.path2D, 'evenodd');
        trailCtx!.restore();
      }
    }
  }

  function paintTrailSmooth(
    s: ModeSnapshot,
    phase: number,
    alpha: number,
    layers: number,
    tx: number,
    ty: number,
    w: number,
    h: number,
  ) {
    if (!maskCtx || !gradCtx) return;

    for (const line of lines) {
      setupSurface(maskLayer, maskCtx, w, h);
      maskCtx.clearRect(0, 0, w, h);
      maskCtx.fillStyle = '#fff';
      for (let i = 1; i <= layers; i++) {
        maskCtx.save();
        maskCtx.translate(line.anchor.cx + tx * i, line.anchor.cy + ty * i);
        maskCtx.translate(-line.anchor.cx, -line.anchor.cy);
        maskCtx.fill(line.path2D, 'evenodd');
        maskCtx.restore();
      }

      setupSurface(gradLayer, gradCtx, w, h);
      gradCtx.clearRect(0, 0, w, h);
      fillSmoothGradient(
        gradCtx,
        s,
        line.anchor.cx,
        line.anchor.cy,
        line.anchor.cx + tx * layers,
        line.anchor.cy + ty * layers,
        phase,
        w,
        h,
      );
      gradCtx.globalCompositeOperation = 'destination-in';
      gradCtx.drawImage(maskLayer, 0, 0, gradLayer.width, gradLayer.height);
      gradCtx.globalCompositeOperation = 'source-over';

      trailCtx!.save();
      trailCtx!.globalAlpha = alpha;
      trailCtx!.drawImage(gradLayer, 0, 0, gradLayer.width, gradLayer.height, 0, 0, w, h);
      trailCtx!.restore();
    }
  }

  function paintTrail(s: ModeSnapshot, phase: number, alpha: number, w: number, h: number, animating: boolean) {
    const e = s.visual.elastic;
    const pal = palette(s);
    const mode = e.trailGradientMode ?? 'striped';
    const layers = layerCount(s);
    const { tx, ty } = trailStep(s);
    const key = `${layoutSig}|${mode}|${layers}|${e.directionDeg}|${e.stepSize}|${pal.join(',')}|${phase.toFixed(3)}|${alpha}|${s.visual.colorMode}`;

    if (!animating && trailReady && key === trailKey && trailLayer.width > 0) {
      return;
    }
    if (!trailCtx) return;

    trailKey = key;
    trailReady = true;
    setupSurface(trailLayer, trailCtx, w, h);
    trailCtx.clearRect(0, 0, w, h);

    if (mode === 'smooth') {
      paintTrailSmooth(s, phase, alpha, layers, tx, ty, w, h);
    } else {
      paintTrailStriped(s, phase, alpha, layers, tx, ty);
    }
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
    setupSurface(textLayer, textCtx, w, h);
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
    clearNeutral(ctx, w, h, s.visual.stageBackground);
    applyMultiplyBlend(ctx, s.visual.multiplyBlend);

    const alpha = effectOpacity(s.visual);
    const animating = s.visual.animationEnabled && !s.visual.sceneFrozen && lines.length > 0;

    if (animating) {
      flowPhase += s.visual.elastic.flowSpeed * (gsap.ticker.deltaRatio() / 60);
    }

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
      trailKey = '';
      trailReady = false;
      textKey = '';
      textReady = false;
      lines = [];

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
