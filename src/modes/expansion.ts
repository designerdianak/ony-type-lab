import gsap from 'gsap';
import type opentype from 'opentype.js';
import type { Paths } from 'js-angusj-clipper';
import { DEFAULT_PLAYGROUND_VISUAL, type ExpansionSettings } from '../types/playground';
import { clearNeutral } from '../utils/canvas';
import { fillGlyphPath } from '../utils/opentypeCanvas';
import {
  normalizeExpansion,
  RIPPLE_BIAS_SHIFT,
  RIPPLE_FLOW_SPEED,
  rippleReach,
  rippleRingFillColor,
  rippleStepRadius,
  rippleStrokeColor,
  rippleUsesStrokes,
} from '../utils/rippleOffset';
import { layoutTextForCanvas } from '../utils/textLayout';
import {
  buildTextSilhouette,
  drawVectorRippleGrow,
  drawVectorRippleStatic,
  getVectorClipper,
  initVectorClipper,
  offsetPathsWithBias,
  pathsToPath2D,
} from '../utils/vectorOffset';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

type Lay = { char: string; x: number; bl: number };

const MIN_COUNT = 2;
const MAX_COUNT = 100;
const PARTIAL_STEPS = 20;

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
  const partialCache = new Map<string, Path2D>();
  let topGen = 0;
  let chainSig = '';

  let clipperReady = false;
  let flowPhase = 0;
  let tickerFn: (() => void) | null = null;
  let tabVisible = true;

  const effectLayer = document.createElement('canvas');
  const effectCtx = effectLayer.getContext('2d');
  let layerKey = '';
  let layerReady = false;

  function onVis() {
    tabVisible = !document.hidden;
  }

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
      flowPhase = 0;
      partialCache.clear();
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
    scale = 1,
  ): Paths {
    const clipper = getVectorClipper();
    if (!clipper) return [];
    const delta = stepPx(exp, gen, w, h, count) * scale;
    if (delta <= 0) return prev;
    return offsetPathsWithBias(
      clipper,
      prev,
      delta,
      exp.horizontalBias,
      exp.verticalBias,
      RIPPLE_BIAS_SHIFT,
    );
  }

  function cacheGen(gen: number) {
    const paths = shapes.get(gen);
    if (!paths?.length) {
      path2DCache.delete(gen);
      return;
    }
    path2DCache.set(gen, pathsToPath2D(paths));
  }

  function clearCaches() {
    path2DCache.clear();
    partialCache.clear();
  }

  function buildTo(exp: ExpansionSettings, target: number, w: number, h: number, count: number) {
    while (topGen < target) {
      const next = topGen + 1;
      const prev = shapes.get(topGen);
      if (!prev?.length) break;
      const nextShape = offsetStep(exp, next, prev, w, h, count);
      if (!nextShape.length) break;
      shapes.set(next, nextShape);
      cacheGen(next);
      topGen = next;
      layerReady = false;
      partialCache.clear();
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
    cacheGen(0);
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
      'vector-v3',
    ].join('|');

    if (sig !== chainSig) {
      chainSig = sig;
      layerKey = '';
      layerReady = false;
      flowPhase = 0;
      resetChain(s);
    }

    if (topGen < count) {
      buildTo(exp, count, w, h, count);
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

  function partialOuterPath2D(
    exp: ExpansionSettings,
    gen: number,
    frac: number,
    w: number,
    h: number,
    count: number,
  ): Path2D | null {
    const q = Math.round(frac * PARTIAL_STEPS) / PARTIAL_STEPS;
    if (q <= 0) return path2DCache.get(gen) ?? null;
    if (q >= 1) return path2DCache.get(gen + 1) ?? null;

    const key = `${chainSig}|${gen}|${q}`;
    const cached = partialCache.get(key);
    if (cached) return cached;

    const inner = shapes.get(gen);
    if (!inner?.length) return null;

    const partial = offsetStep(exp, gen + 1, inner, w, h, count, q);
    if (!partial.length) return path2DCache.get(gen) ?? null;

    const p2d = pathsToPath2D(partial);
    partialCache.set(key, p2d);
    return p2d;
  }

  function setupEffectSurface(w: number, h: number) {
    if (!effectCtx) return 1;
    const dpr = canvasDpr(w, ctx.canvas);
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (effectLayer.width !== pw) effectLayer.width = pw;
    if (effectLayer.height !== ph) effectLayer.height = ph;
    effectCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    effectCtx.imageSmoothingEnabled = true;
    effectCtx.imageSmoothingQuality = 'high';
    return dpr;
  }

  function blitEffectLayer(w: number, h: number) {
    const dpr = canvasDpr(w, ctx.canvas);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(effectLayer, 0, 0, effectLayer.width, effectLayer.height, 0, 0, w * dpr, h * dpr);
    ctx.restore();
  }

  function paintEffectLayer(
    exp: ExpansionSettings,
    count: number,
    phase: number,
    stageBg: string,
    lw: number,
    alpha: number,
    w: number,
    h: number,
    animating: boolean,
  ) {
    const phaseKey = animating ? phase.toFixed(4) : 'static';
    const key = `${phaseKey}|${count}|${topGen}|${lw}|${alpha}|${colorSig(exp, count)}`;
    if (!animating && layerReady && key === layerKey && effectLayer.width > 0) {
      return;
    }
    if (!effectCtx) return;

    layerKey = key;
    layerReady = true;
    setupEffectSurface(w, h);
    effectCtx.clearRect(0, 0, w, h);

    const visibleRings = Math.min(count, topGen);
    if (visibleRings < 1) return;

    const useStrokes = rippleUsesStrokes(exp);
    const drawStyle = useStrokes ? 'ring' : 'solid';

    if (animating) {
      drawVectorRippleGrow(
        effectCtx,
        visibleRings,
        phase,
        (g) => path2DCache.get(g) ?? null,
        (g, frac) => partialOuterPath2D(exp, g, frac, w, h, count),
        drawStyle,
        (g) => ringFillForGen(exp, g, stageBg),
        useStrokes ? () => rippleStrokeColor(exp) : null,
        lw,
        alpha,
      );
      return;
    }

    drawVectorRippleStatic(
      effectCtx,
      (g) => path2DCache.get(g) ?? null,
      visibleRings,
      drawStyle,
      (g) => ringFillForGen(exp, g, stageBg),
      useStrokes ? () => rippleStrokeColor(exp) : null,
      lw,
      alpha,
    );
  }

  function drawTextTop(textColor: string, alpha: number, font: opentype.Font) {
    ctx.save();
    ctx.globalAlpha = alpha;
    for (const g of lays) {
      fillGlyphPath(ctx, font.getPath(g.char, g.x, g.bl, layoutFontSize), textColor);
    }
    ctx.restore();
  }

  function tick() {
    try {
      const s = getSnap();
      const { w, h } = viewport();
      if (w < 32 || h < 32) return;

      ensureLayout();
      ensureChain(s);
      clearNeutral(ctx, w, h, s.visual.stageBackground);

      if (!clipperReady || !shapes.has(0) || lays.length === 0) {
        if (s.opentypeFont && lays.length > 0) {
          drawTextTop(s.visual.monochromeColor, effectOpacity(s.visual), s.opentypeFont);
        }
        return;
      }

      const exp = settings(s);
      const count = contourCount(exp);
      const alpha = effectOpacity(s.visual);
      const lw = Math.max(0.35, exp.strokeWidth);
      const animating =
        !s.visual.sceneFrozen &&
        s.visual.animationEnabled &&
        tabVisible &&
        topGen >= count;

      if (animating) {
        flowPhase += RIPPLE_FLOW_SPEED * (gsap.ticker.deltaRatio() / 60);
      }

      if (topGen >= 1) {
        paintEffectLayer(
          exp,
          count,
          flowPhase,
          s.visual.stageBackground,
          lw,
          alpha,
          w,
          h,
          animating,
        );
        if (effectLayer.width > 0) {
          blitEffectLayer(w, h);
        }
      }

      if (s.opentypeFont) {
        drawTextTop(s.visual.monochromeColor, alpha, s.opentypeFont);
      }
    } catch (err) {
      console.error('[Ripple] tick failed', err);
    }
  }

  return {
    start() {
      document.addEventListener('visibilitychange', onVis);
      tabVisible = !document.hidden;
      clipperReady = false;
      layoutSig = '';
      chainSig = '';
      layerKey = '';
      layerReady = false;
      shapes.clear();
      clearCaches();
      topGen = 0;
      flowPhase = 0;
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
      document.removeEventListener('visibilitychange', onVis);
      if (tickerFn) gsap.ticker.remove(tickerFn);
      tickerFn = null;
    },
    dispose() {
      this.stop();
    },
    interruptInteraction() {},
  };
}
