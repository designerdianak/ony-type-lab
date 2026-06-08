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
  drawVectorRippleCarousel,
  getVectorClipper,
  initVectorClipper,
  offsetPathsWithBias,
  pathsBoundsCenter,
  pathsToPath2D,
  shapeMaxRadius,
} from '../utils/vectorOffset';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

type Lay = { char: string; x: number; bl: number };

const MIN_COUNT = 2;
const MAX_COUNT = 100;
/** Сколько offset-шагов считаем за кадр — не блокируем UI. */
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
  const radiusCache = new Map<number, number>();
  let topGen = 0;
  let chainSig = '';
  let shapeCenter = { cx: 0, cy: 0 };

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
      radiusCache.delete(gen);
      return;
    }
    path2DCache.set(gen, pathsToPath2D(paths));
    radiusCache.set(gen, shapeMaxRadius(paths, shapeCenter));
  }

  function clearCaches() {
    path2DCache.clear();
    radiusCache.clear();
  }

  function buildTo(
    exp: ExpansionSettings,
    target: number,
    w: number,
    h: number,
    count: number,
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
      cacheGen(next);
      topGen = next;
      n++;
      layerReady = false;
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
    shapeCenter = pathsBoundsCenter(shape0);
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
      'vector-v2',
    ].join('|');

    if (sig !== chainSig) {
      chainSig = sig;
      flowPhase = 0;
      layerKey = '';
      layerReady = false;
      resetChain(s);
    }

    if (topGen < count) {
      buildTo(exp, count, w, h, count, BUILD_BUDGET);
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

  function paintEffectLayer(
    exp: ExpansionSettings,
    count: number,
    phase: number,
    stageBg: string,
    lw: number,
    alpha: number,
    w: number,
    h: number,
    frozen: boolean,
  ) {
    const phaseKey = frozen ? '0' : phase.toFixed(2);
    const key = `${phaseKey}|${count}|${topGen}|${lw}|${alpha}|${colorSig(exp, count)}`;
    if (layerReady && key === layerKey && effectLayer.width === w && effectLayer.height === h) return;
    if (!effectCtx) return;

    layerKey = key;
    layerReady = true;
    if (effectLayer.width !== w) effectLayer.width = w;
    if (effectLayer.height !== h) effectLayer.height = h;
    effectCtx.clearRect(0, 0, w, h);

    const visibleRings = Math.min(count, topGen);
    if (visibleRings < 1) return;

    const useStrokes = rippleUsesStrokes(exp);
    drawVectorRippleCarousel(
      effectCtx,
      (g) => path2DCache.get(g) ?? null,
      (g) => radiusCache.get(g) ?? 1,
      visibleRings,
      phase,
      shapeCenter,
      (g) => stepPx(exp, g, w, h, count),
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
      let phase = 0;
      const animating = !s.visual.sceneFrozen && tabVisible && topGen >= count;
      if (animating) {
        flowPhase += RIPPLE_FLOW_SPEED * 6 * (gsap.ticker.deltaRatio() / 60);
        phase = flowPhase;
      }

      if (topGen >= 1) {
        paintEffectLayer(exp, count, phase, s.visual.stageBackground, lw, alpha, w, h, !animating);
        if (effectCtx && effectLayer.width > 0) {
          ctx.drawImage(effectLayer, 0, 0);
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
