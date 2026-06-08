import gsap from 'gsap';
import type opentype from 'opentype.js';
import { DEFAULT_PLAYGROUND_VISUAL, type ExpansionSettings } from '../types/playground';
import { clearNeutral } from '../utils/canvas';
import { rasterizeGlyphMask, type GlyphSlot } from '../utils/contourField';
import {
  drawOffsetContourCached,
  extractMaskLoops,
  maskHasInk,
  type Pt,
} from '../utils/iterativeContours';
import { fillGlyphPath } from '../utils/opentypeCanvas';
import {
  normalizeExpansion,
  offsetFromPrevInto,
  RIPPLE_FLOW_SPEED,
  rippleBaseStepCells,
  rippleGridCell,
  rippleRasterPad,
  rippleReach,
  rippleRingFill,
  rippleStrokeColor,
} from '../utils/rippleOffset';
import { layoutTextForCanvas } from '../utils/textLayout';
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

export function createExpansionMode(
  _canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let layoutFontSize = 72;
  let layoutFontCss = '';
  let lays: Lay[] = [];
  let layoutSig = '';

  const shapes = new Map<number, Uint8Array>();
  const loops = new Map<number, Pt[][]>();
  const maskPool: Uint8Array[] = [];
  let topGen = 0;
  let chainSig = '';

  let gridCw = 0;
  let gridCh = 0;
  let gridCell = 2;
  let gridPad = 0;
  let baseRadius = 1;

  let workScratch: Uint8Array | null = null;

  let flowPhase = 0;
  let flowHead = 0;
  let tickerFn: (() => void) | null = null;
  let tabVisible = true;

  const ringScratch = document.createElement('canvas');
  const segBuf: { x0: number; y0: number; x1: number; y1: number }[] = [];

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

  function allocMask(size: number): Uint8Array {
    const pooled = maskPool.pop();
    if (pooled && pooled.length === size) return pooled;
    return new Uint8Array(size);
  }

  function releaseGen(gen: number) {
    const m = shapes.get(gen);
    if (m) maskPool.push(m);
    shapes.delete(gen);
    loops.delete(gen);
  }

  function gcBelow(minGen: number) {
    for (const g of [...shapes.keys()]) {
      if (g > 0 && g < minGen) releaseGen(g);
    }
  }

  function cacheLoops(gen: number, mask: Uint8Array) {
    loops.set(gen, extractMaskLoops(mask, gridCw, gridCh, gridCell, segBuf));
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
    layoutFontCss = block.effectiveFontCss;
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

  function ensureWork(size: number) {
    if (!workScratch || workScratch.length !== size) {
      workScratch = new Uint8Array(size);
    }
  }

  function offsetStep(exp: ExpansionSettings, gen: number, prev: Uint8Array): Uint8Array {
    ensureWork(prev.length);
    const out = allocMask(prev.length);
    offsetFromPrevInto(
      prev,
      out,
      gen,
      gridCw,
      gridCh,
      baseRadius,
      exp.distribution,
      exp.falloffStrength,
      exp.horizontalBias,
      exp.verticalBias,
      workScratch!,
    );
    return out;
  }

  function buildTo(exp: ExpansionSettings, target: number, budget = MAX_OFFSET_PER_TICK) {
    let n = 0;
    while (topGen < target && n < budget) {
      const next = topGen + 1;
      const prev = shapes.get(topGen);
      if (!prev) break;
      const mask = offsetStep(exp, next, prev);
      shapes.set(next, mask);
      cacheLoops(next, mask);
      topGen = next;
      n++;
    }
  }

  function resetChain(s: ModeSnapshot) {
    const { w, h } = viewport();
    for (const g of shapes.keys()) releaseGen(g);
    topGen = 0;
    workScratch = null;
    layerKey = '';
    maskPool.length = 0;

    if (w < 32 || h < 32 || lays.length === 0) return;

    const exp = settings(s);
    const count = contourCount(exp);
    const reach = rippleReach(w, h, exp.horizontalBias, exp.verticalBias);
    const stepPx = reach / count;
    gridCell = rippleGridCell(stepPx, w, h, count);
    gridPad = rippleRasterPad(reach, w, h);
    baseRadius = rippleBaseStepCells(w, h, count, gridCell, exp.horizontalBias, exp.verticalBias);

    const rw = w + gridPad * 2;
    const rh = h + gridPad * 2;
    const slots: GlyphSlot[] = lays.map((g) => ({
      char: g.char,
      x: g.x + gridPad,
      bl: g.bl + gridPad,
    }));

    const raster = rasterizeGlyphMask(
      rw,
      rh,
      gridCell,
      slots,
      layoutFontCss || s.fontCss,
      layoutFontSize,
      s.opentypeFont,
    );
    if (!maskHasInk(raster.mask)) return;

    gridCw = raster.cw;
    gridCh = raster.ch;
    const shape0 = allocMask(raster.mask.length);
    shape0.set(raster.mask);
    shapes.set(0, shape0);
    buildTo(exp, count, count + 2);
  }

  function ensureChain(s: ModeSnapshot) {
    const { w, h } = viewport();
    if (w < 32 || h < 32 || lays.length === 0) {
      for (const g of shapes.keys()) releaseGen(g);
      topGen = 0;
      return;
    }

    const exp = settings(s);
    const count = contourCount(exp);
    const reach = rippleReach(w, h, exp.horizontalBias, exp.verticalBias);
    const stepPx = reach / count;
    const cell = rippleGridCell(stepPx, w, h, count);
    const pad = rippleRasterPad(reach, w, h);
    const radius = rippleBaseStepCells(w, h, count, cell, exp.horizontalBias, exp.verticalBias);

    const sig = [
      layoutSig,
      count,
      cell,
      pad,
      radius,
      exp.distribution,
      exp.falloffStrength,
      exp.horizontalBias,
      exp.verticalBias,
      exp.paletteMode,
      exp.fillColor,
      exp.strokeColor,
      exp.strokeWidth,
      exp.customPalette.join(','),
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
    const key = `${first}|${last}|${fill}|${lw}|${alpha}|${strokeSig(exp, first, last)}|${gridPad}|${gridCell}`;
    if (key === layerKey && effectLayer.width === w && effectLayer.height === h) return;
    if (!effectCtx) return;

    layerKey = key;
    if (effectLayer.width !== w) effectLayer.width = w;
    if (effectLayer.height !== h) effectLayer.height = h;
    effectCtx.clearRect(0, 0, w, h);

    drawOffsetContourCached(
      effectCtx,
      (g) => shapes.get(g) ?? null,
      (g) => loops.get(g) ?? null,
      first,
      last,
      gridCw,
      gridCh,
      gridCell,
      -gridPad,
      -gridPad,
      fill,
      (g) => rippleStrokeColor(exp, g),
      lw,
      alpha,
      ringScratch,
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

      const exp = settings(s);
      const count = contourCount(exp);
      if (!shapes.has(0) || topGen < 1 || lays.length === 0) return;

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
          buildTo(exp, head + count, MAX_OFFSET_PER_TICK);
          gcBelow(head - GC_MARGIN);
        }
        first = head + 1;
        last = head + count;
        if (topGen < last) buildTo(exp, last, MAX_OFFSET_PER_TICK);
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
      layoutSig = '';
      chainSig = '';
      layerKey = '';
      for (const g of shapes.keys()) releaseGen(g);
      topGen = 0;
      flowPhase = 0;
      flowHead = 0;
      workScratch = null;
      rebuildLayout();
      ensureChain(getSnap());
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
