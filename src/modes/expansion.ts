import gsap from 'gsap';
import type opentype from 'opentype.js';
import type { Paths } from 'js-angusj-clipper';
import { DEFAULT_PLAYGROUND_VISUAL, type ExpansionSettings } from '../types/playground';
import { clearNeutral } from '../utils/canvas';
import { fillGlyphPath } from '../utils/opentypeCanvas';
import {
  normalizeExpansion,
  RIPPLE_FLOW_SPEED,
  rippleReach,
  rippleRingFill,
  rippleStepRadius,
  rippleStrokeColor,
} from '../utils/rippleOffset';
import { layoutTextForCanvas } from '../utils/textLayout';
import {
  buildTextSilhouette,
  drawVectorRippleStack,
  getVectorClipper,
  initVectorClipper,
  offsetPaths,
  pathsBoundsCenter,
} from '../utils/vectorOffset';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

type Lay = { char: string; x: number; bl: number };

const MIN_COUNT = 2;
const MAX_COUNT = 100;
const GC_MARGIN = 1;
const MAX_OFFSET_PER_TICK = 2;

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
  let topGen = 0;
  let chainSig = '';
  let shapeCenter = { cx: 0, cy: 0 };

  let clipperReady = false;
  let flowPhase = 0;
  let flowHead = 0;
  let tickerFn: (() => void) | null = null;
  let tabVisible = true;

  const effectLayer = document.createElement('canvas');
  const effectCtx = effectLayer.getContext('2d');
  let layerKey = '';

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
    );
    layoutFontSize = block.effectiveFontSize;
    lays = block.glyphs.map((g) => ({ char: g.char, x: g.x, bl: g.baseline }));
  }

  function ensureLayout() {
    const s = getSnap();
    const { w, h } = viewport();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${w}|${h}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      chainSig = '';
      layerKey = '';
      flowPhase = 0;
      flowHead = 0;
      rebuildLayout();
    }
  }

  function releaseGen(gen: number) {
    shapes.delete(gen);
  }

  function gcBelow(minGen: number) {
    for (const g of [...shapes.keys()]) {
      if (g > 0 && g < minGen) releaseGen(g);
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
    return offsetPaths(
      clipper,
      prev,
      stepPx(exp, gen, w, h, count),
      exp.horizontalBias,
      exp.verticalBias,
      shapeCenter,
    );
  }

  function buildTo(
    exp: ExpansionSettings,
    target: number,
    w: number,
    h: number,
    count: number,
    budget = MAX_OFFSET_PER_TICK,
  ) {
    let n = 0;
    while (topGen < target && n < budget) {
      const next = topGen + 1;
      const prev = shapes.get(topGen);
      if (!prev?.length) break;
      const nextShape = offsetStep(exp, next, prev, w, h, count);
      if (!nextShape.length) break;
      shapes.set(next, nextShape);
      topGen = next;
      n++;
    }
  }

  function resetChain(s: ModeSnapshot) {
    const { w, h } = viewport();
    shapes.clear();
    topGen = 0;
    layerKey = '';

    const clipper = getVectorClipper();
    if (!clipper || w < 32 || h < 32 || lays.length === 0 || !s.opentypeFont) return;

    const exp = settings(s);
    const count = contourCount(exp);

    const shape0 = buildTextSilhouette(clipper, s.opentypeFont, lays, layoutFontSize);
    if (!shape0.length) return;

    shapes.set(0, shape0);
    shapeCenter = pathsBoundsCenter(shape0);
    buildTo(exp, count, w, h, count, count + 2);
  }

  function ensureChain(s: ModeSnapshot) {
    const { w, h } = viewport();
    if (!clipperReady) return;

    if (w < 32 || h < 32 || lays.length === 0 || !s.opentypeFont) {
      shapes.clear();
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
      'vector',
    ].join('|');

    if (sig === chainSig && shapes.has(0) && topGen >= count) return;

    chainSig = sig;
    flowPhase = 0;
    flowHead = 0;
    layerKey = '';
    resetChain(s);
  }

  function strokeSig(exp: ExpansionSettings, first: number, last: number): string {
    if (exp.paletteMode === 'custom') {
      const parts: string[] = [];
      for (let g = first; g <= last; g++) parts.push(rippleStrokeColor(exp, g));
      return parts.join(',');
    }
    return exp.strokeColor;
  }

  function ringFillValue(exp: ExpansionSettings, stageBg: string): string | null {
    const ringFill = rippleRingFill(exp);
    if (stageBg === 'transparent') return null;
    if (ringFill === 'transparent') return stageBg;
    return ringFill;
  }

  function paintEffectLayer(
    exp: ExpansionSettings,
    first: number,
    last: number,
    fill: string | null,
    lw: number,
    alpha: number,
    w: number,
    h: number,
  ) {
    const key = `${first}|${last}|${fill}|${lw}|${alpha}|${strokeSig(exp, first, last)}|vector`;
    if (key === layerKey && effectLayer.width === w && effectLayer.height === h) return;
    if (!effectCtx) return;

    layerKey = key;
    if (effectLayer.width !== w) effectLayer.width = w;
    if (effectLayer.height !== h) effectLayer.height = h;
    effectCtx.clearRect(0, 0, w, h);

    drawVectorRippleStack(
      effectCtx,
      (g) => shapes.get(g) ?? null,
      first,
      last,
      fill,
      (g) => rippleStrokeColor(exp, g),
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

      if (!clipperReady || !shapes.has(0) || topGen < 1 || lays.length === 0) {
        if (s.opentypeFont && lays.length > 0) {
          drawTextTop(s.visual.monochromeColor, effectOpacity(s.visual), s.opentypeFont);
        }
        return;
      }

      const exp = settings(s);
      const count = contourCount(exp);
      const alpha = effectOpacity(s.visual);
      const lw = Math.max(0.35, exp.strokeWidth);
      const fill = ringFillValue(exp, s.visual.stageBackground);

      let first = 1;
      let last = count;

      if (!s.visual.sceneFrozen && tabVisible) {
        flowPhase += RIPPLE_FLOW_SPEED * (gsap.ticker.deltaRatio() / 60) * 9;
        const head = Math.floor(flowPhase);
        if (head !== flowHead) {
          flowHead = head;
          layerKey = '';
          buildTo(exp, head + count, w, h, count, MAX_OFFSET_PER_TICK);
          gcBelow(head - GC_MARGIN);
        }
        first = head + 1;
        last = head + count;
        if (topGen < last) buildTo(exp, last, w, h, count, MAX_OFFSET_PER_TICK);
      }

      paintEffectLayer(exp, first, last, fill, lw, alpha, w, h);
      if (effectCtx && effectLayer.width > 0) {
        ctx.drawImage(effectLayer, 0, 0);
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
      shapes.clear();
      topGen = 0;
      flowPhase = 0;
      flowHead = 0;
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
