import gsap from 'gsap';
import type opentype from 'opentype.js';
import type { Paths } from 'js-angusj-clipper';
import { DEFAULT_PLAYGROUND_VISUAL, type ExpansionSettings } from '../types/playground';
import { clearNeutral } from '../utils/canvas';
import { fillGlyphPath } from '../utils/opentypeCanvas';
import {
  normalizeExpansion,
  RIPPLE_BIAS_SHIFT,
  rippleReach,
  rippleRingFillColor,
  rippleStepRadius,
  rippleStrokeColor,
  rippleUsesStrokes,
} from '../utils/rippleOffset';
import { layoutTextForCanvas } from '../utils/textLayout';
import {
  buildTextSilhouette,
  drawVectorRippleStatic,
  getVectorClipper,
  initVectorClipper,
  offsetPathsWithBias,
  pathsToPath2D,
  pathsToRingPath2D,
  simplifyRipplePaths,
} from '../utils/vectorOffset';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

type Lay = { char: string; x: number; bl: number };

const MIN_COUNT = 2;
const MAX_COUNT = 100;
/** Offset-шагов за кадр — цепочка растёт без фриза UI. */
const BUILD_BUDGET = 4;

function settings(s: ModeSnapshot): ExpansionSettings {
  return normalizeExpansion({
    ...DEFAULT_PLAYGROUND_VISUAL.expansion,
    ...s.visual.expansion,
  });
}

function contourCount(exp: ExpansionSettings): number {
  const n = Math.round(exp.contourCount);
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, Number.isFinite(n) ? n : 28));
}

function baseStepPx(w: number, h: number, count: number): number {
  return rippleReach(w, h, 0, 0) / Math.max(2, count);
}

function canvasDpr(w: number, canvas: HTMLCanvasElement): number {
  return canvas.width / Math.max(1, w);
}

export function createExpansionMode(
  _canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let layoutFontSize = 72;
  let lays: Lay[] = [];
  let layoutSig = '';

  const shapes = new Map<number, Paths>();
  const path2DCache = new Map<number, Path2D>();
  const ringPath2DCache = new Map<number, Path2D>();
  let topGen = 0;
  let chainSig = '';

  let clipperReady = false;
  let tickerFn: (() => void) | null = null;

  const effectLayer = document.createElement('canvas');
  const effectCtx = effectLayer.getContext('2d');
  let layerKey = '';
  let layerReady = false;

  const textLayer = document.createElement('canvas');
  const textCtx = textLayer.getContext('2d');
  let textLayerKey = '';
  let textLayerReady = false;

  function viewport() {
    const s = getSnap();
    return { w: Math.max(1, Math.round(s.w)), h: Math.max(1, Math.round(s.h)) };
  }

  function rebuildLayout() {
    const s = getSnap();
    const { w, h } = viewport();
    if (!s.text.trim()) {
      lays = [];
      return;
    }
    const block = layoutTextForCanvas(
      ctx,
      s.text.trim(),
      s.fontCss,
      s.fontSize,
      s.letterSpacing,
      w,
      h,
      s.lineHeight,
    );
    layoutFontSize = block.effectiveFontSize;
    lays = block.glyphs.map((g) => ({ char: g.char, x: g.x, bl: g.baseline }));
  }

  function ensureLayout() {
    const s = getSnap();
    const { w, h } = viewport();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.lineHeight}|${w}|${h}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      chainSig = '';
      layerKey = '';
      layerReady = false;
      textLayerKey = '';
      textLayerReady = false;
      rebuildLayout();
    }
  }

  function stepPx(exp: ExpansionSettings, gen: number, w: number, h: number, count: number): number {
    const base = baseStepPx(w, h, count);
    return rippleStepRadius(gen, base, exp.distribution, exp.falloffStrength);
  }

  function offsetStep(
    exp: ExpansionSettings,
    gen: number,
    prev: Paths,
    w: number,
    h: number,
    count: number,
  ): Paths {
    const clipper = getVectorClipper();
    if (!clipper) return [];
    const delta = stepPx(exp, gen, w, h, count);
    const raw = offsetPathsWithBias(
      clipper,
      prev,
      delta,
      exp.horizontalBias,
      exp.verticalBias,
      RIPPLE_BIAS_SHIFT,
      gen,
    );
    if (!raw.length) return [];
    return simplifyRipplePaths(clipper, raw, gen);
  }

  function cacheGen(gen: number, needRings: boolean) {
    const paths = shapes.get(gen);
    if (!paths?.length) {
      path2DCache.delete(gen);
      ringPath2DCache.delete(gen);
      return;
    }
    path2DCache.set(gen, pathsToPath2D(paths));
    if (needRings && gen >= 1) {
      const inner = shapes.get(gen - 1);
      if (inner?.length) {
        ringPath2DCache.set(gen, pathsToRingPath2D(paths, inner));
      }
    } else {
      ringPath2DCache.delete(gen);
    }
  }

  function clearCaches() {
    path2DCache.clear();
    ringPath2DCache.clear();
  }

  function buildTo(
    exp: ExpansionSettings,
    target: number,
    w: number,
    h: number,
    count: number,
    needRings: boolean,
    budget = BUILD_BUDGET,
  ) {
    let n = 0;
    while (topGen < target && n < budget) {
      const next = topGen + 1;
      const prev = shapes.get(topGen);
      if (!prev?.length) break;
      const nextShape = offsetStep(exp, next, prev, w, h, count);
      if (!nextShape.length) break;
      shapes.set(next, nextShape);
      cacheGen(next, needRings);
      topGen = next;
      layerReady = false;
      n++;
    }
  }

  function resetChain(s: ModeSnapshot) {
    const { w, h } = viewport();
    shapes.clear();
    clearCaches();
    topGen = 0;
    layerKey = '';
    layerReady = false;

    const clipper = getVectorClipper();
    if (!clipper || w < 32 || h < 32 || lays.length === 0 || !s.opentypeFont) return;

    const shape0 = buildTextSilhouette(clipper, s.opentypeFont, lays, layoutFontSize);
    if (!shape0.length) return;

    shapes.set(0, shape0);
    cacheGen(0, rippleUsesStrokes(settings(s)));
  }

  function ensureChain(s: ModeSnapshot) {
    const { w, h } = viewport();
    if (!clipperReady) return;

    if (w < 32 || h < 32 || lays.length === 0 || !s.opentypeFont) {
      shapes.clear();
      clearCaches();
      topGen = 0;
      return;
    }

    const exp = settings(s);
    const count = contourCount(exp);
    const step = baseStepPx(w, h, count);

    const sig = [
      layoutSig,
      count,
      step,
      exp.distribution,
      exp.falloffStrength,
      exp.horizontalBias,
      exp.verticalBias,
      exp.paletteMode,
      exp.fillColor,
      exp.strokeColor,
      exp.strokeWidth,
      exp.customPalette.join(','),
      'vector-v4',
    ].join('|');

    if (sig !== chainSig) {
      chainSig = sig;
      layerKey = '';
      layerReady = false;
      resetChain(s);
    }
  }

  function buildChainStep(s: ModeSnapshot) {
    if (!clipperReady || lays.length === 0 || !s.opentypeFont) return;
    const { w, h } = viewport();
    const exp = settings(s);
    const count = contourCount(exp);
    if (topGen < count) {
      buildTo(exp, count, w, h, count, rippleUsesStrokes(exp), BUILD_BUDGET);
    }
  }

  function colorSig(exp: ExpansionSettings, count: number): string {
    const parts: string[] = [exp.paletteMode, exp.fillColor, exp.strokeColor];
    if (exp.paletteMode === 'customFill') {
      for (let g = 1; g <= count; g++) parts.push(rippleRingFillColor(exp, g));
    } else if (exp.paletteMode === 'alternatingFill') {
      for (let g = 1; g <= Math.min(count, 4); g++) parts.push(rippleRingFillColor(exp, g));
    }
    return parts.join(',');
  }

  function ringFillForGen(
    exp: ExpansionSettings,
    outerGen: number,
    stageBg: string,
  ): string | null {
    if (exp.paletteMode === 'contourFill') {
      if (stageBg === 'transparent') return null;
      const ringFill = rippleRingFillColor(exp, outerGen);
      if (ringFill === 'transparent') return stageBg;
      return ringFill;
    }
    return rippleRingFillColor(exp, outerGen);
  }

  function setupSurface(layer: HTMLCanvasElement, layerCtx: CanvasRenderingContext2D, w: number, h: number) {
    const dpr = canvasDpr(w, ctx.canvas);
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (layer.width !== pw) layer.width = pw;
    if (layer.height !== ph) layer.height = ph;
    layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layerCtx.imageSmoothingEnabled = true;
    layerCtx.imageSmoothingQuality = 'high';
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

  function paintEffectLayer(
    exp: ExpansionSettings,
    count: number,
    stageBg: string,
    lw: number,
    alpha: number,
    w: number,
    h: number,
  ) {
    const key = `${count}|${topGen}|${lw}|${alpha}|${stageBg}|${colorSig(exp, count)}`;
    if (layerReady && key === layerKey && effectLayer.width > 0) {
      return;
    }
    if (!effectCtx) return;

    layerKey = key;
    layerReady = true;
    setupSurface(effectLayer, effectCtx, w, h);
    effectCtx.clearRect(0, 0, w, h);

    const visibleRings = Math.min(count, topGen);
    if (visibleRings < 1) return;

    const useStrokes = rippleUsesStrokes(exp);
    const drawStyle = useStrokes ? 'ring' : 'solid';
    drawVectorRippleStatic(
      effectCtx,
      (g) => path2DCache.get(g) ?? null,
      visibleRings,
      drawStyle,
      (g) => ringFillForGen(exp, g, stageBg),
      useStrokes ? () => rippleStrokeColor(exp) : null,
      lw,
      alpha,
      useStrokes ? (g) => ringPath2DCache.get(g) ?? null : undefined,
    );
  }

  function drawTextTop(textColor: string, alpha: number, font: opentype.Font, w: number, h: number) {
    const key = `${layoutSig}|${textColor}|${alpha}|${layoutFontSize}`;
    if (textLayerReady && key === textLayerKey && textLayer.width > 0) {
      blitLayer(textLayer, w, h);
      return;
    }
    if (!textCtx) return;

    textLayerKey = key;
    textLayerReady = true;
    setupSurface(textLayer, textCtx, w, h);
    textCtx.clearRect(0, 0, w, h);
    textCtx.save();
    textCtx.globalAlpha = alpha;
    for (const g of lays) {
      fillGlyphPath(textCtx, font.getPath(g.char, g.x, g.bl, layoutFontSize), textColor);
    }
    textCtx.restore();
    blitLayer(textLayer, w, h);
  }

  function tick() {
    try {
      const s = getSnap();
      const { w, h } = viewport();
      if (w < 32 || h < 32) return;

      ensureLayout();
      ensureChain(s);
      buildChainStep(s);
      clearNeutral(ctx, w, h, s.visual.stageBackground);

      if (!clipperReady || !shapes.has(0) || lays.length === 0) {
        if (s.opentypeFont && lays.length > 0) {
          drawTextTop(s.visual.monochromeColor, effectOpacity(s.visual), s.opentypeFont, w, h);
        }
        return;
      }

      const exp = settings(s);
      const count = contourCount(exp);
      const alpha = effectOpacity(s.visual);
      const lw = Math.max(0.35, exp.strokeWidth);

      if (topGen >= 1) {
        paintEffectLayer(exp, count, s.visual.stageBackground, lw, alpha, w, h);
        if (effectLayer.width > 0) {
          blitLayer(effectLayer, w, h);
        }
      }

      if (s.opentypeFont) {
        drawTextTop(s.visual.monochromeColor, alpha, s.opentypeFont, w, h);
      }
    } catch (err) {
      console.error('[Ripple] tick failed', err);
    }
  }

  return {
    start() {
      clipperReady = false;
      layoutSig = '';
      chainSig = '';
      layerKey = '';
      layerReady = false;
      textLayerKey = '';
      textLayerReady = false;
      shapes.clear();
      clearCaches();
      topGen = 0;
      rebuildLayout();

      initVectorClipper()
        .then(() => {
          clipperReady = true;
          ensureChain(getSnap());
        })
        .catch((err) => console.error('[Ripple] clipper load failed', err));

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
