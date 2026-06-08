import gsap from 'gsap';
import type opentype from 'opentype.js';
import { DEFAULT_PLAYGROUND_VISUAL, type ExpansionSettings } from '../types/playground';
import { clearNeutral } from '../utils/canvas';
import { rasterizeGlyphMask, type GlyphSlot } from '../utils/contourField';
import { drawOffsetContourRange, maskHasInk } from '../utils/iterativeContours';
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
const MAX_COUNT = 160;
const GC_MARGIN = 2;

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

  /** Shape0…ShapeK — rolling cache цепочки offset. */
  const shapes = new Map<number, Uint8Array>();
  let topGen = 0;
  let chainSig = '';

  let gridCw = 0;
  let gridCh = 0;
  let gridCell = 2;
  let gridPad = 0;
  let baseRadius = 1;

  let bufA: Uint8Array | null = null;
  let bufB: Uint8Array | null = null;

  let flowPhase = 0;
  let flowHead = 0;
  let tickerFn: (() => void) | null = null;

  const ringScratch = document.createElement('canvas');
  const segBuf: { x0: number; y0: number; x1: number; y1: number }[] = [];

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
      flowPhase = 0;
      flowHead = 0;
      rebuildLayout();
    }
  }

  function gcBelow(minGen: number) {
    for (const g of shapes.keys()) {
      if (g > 0 && g < minGen) shapes.delete(g);
    }
  }

  function offsetStep(exp: ExpansionSettings, gen: number, prev: Uint8Array): Uint8Array {
    if (!bufA || bufA.length !== prev.length) {
      bufA = new Uint8Array(prev.length);
      bufB = new Uint8Array(prev.length);
    }
    offsetFromPrevInto(
      prev,
      bufA,
      gen,
      gridCw,
      gridCh,
      baseRadius,
      exp.distribution,
      exp.falloffStrength,
      exp.horizontalBias,
      exp.verticalBias,
      bufB ?? undefined,
    );
    return new Uint8Array(bufA);
  }

  function buildTo(exp: ExpansionSettings, target: number) {
    while (topGen < target) {
      const next = topGen + 1;
      const prev = shapes.get(topGen);
      if (!prev) break;
      shapes.set(next, offsetStep(exp, next, prev));
      topGen = next;
    }
  }

  function resetChain(s: ModeSnapshot) {
    const { w, h } = viewport();
    shapes.clear();
    topGen = 0;
    bufA = null;
    bufB = null;

    if (w < 32 || h < 32 || lays.length === 0) return;

    const exp = settings(s);
    const count = contourCount(exp);
    const reach = rippleReach(w, h, exp.horizontalBias, exp.verticalBias);
    const stepPx = reach / count;
    gridCell = rippleGridCell(stepPx, w, h);
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
    shapes.set(0, new Uint8Array(raster.mask));
    buildTo(exp, count);
  }

  function ensureChain(s: ModeSnapshot) {
    const { w, h } = viewport();
    if (w < 32 || h < 32 || lays.length === 0) {
      shapes.clear();
      topGen = 0;
      return;
    }

    const exp = settings(s);
    const count = contourCount(exp);
    const reach = rippleReach(w, h, exp.horizontalBias, exp.verticalBias);
    const stepPx = reach / count;
    const cell = rippleGridCell(stepPx, w, h);
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
    resetChain(s);
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
      const ringFill = rippleRingFill(exp);
      const lw = Math.max(0.35, exp.strokeWidth);

      let first = 1;
      let last = count;

      if (!s.visual.sceneFrozen) {
        flowPhase += RIPPLE_FLOW_SPEED * (gsap.ticker.deltaRatio() / 60) * 9;
        const head = Math.floor(flowPhase);
        if (head !== flowHead) {
          flowHead = head;
          buildTo(exp, head + count);
          gcBelow(head - GC_MARGIN);
        }
        first = head + 1;
        last = head + count;
        buildTo(exp, last);
      }

      const fill =
        ringFill === 'transparent' || s.visual.stageBackground === 'transparent'
          ? s.visual.stageBackground === 'transparent'
            ? null
            : ringFill
          : ringFill;

      drawOffsetContourRange(
        ctx,
        (g) => shapes.get(g) ?? null,
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
        segBuf,
        ringScratch,
      );

      if (s.opentypeFont) {
        drawTextTop(s.visual.monochromeColor, alpha, s.opentypeFont);
      }
    } catch (err) {
      console.error('[Ripple] tick failed', err);
    }
  }

  return {
    start() {
      layoutSig = '';
      chainSig = '';
      shapes.clear();
      topGen = 0;
      flowPhase = 0;
      flowHead = 0;
      bufA = null;
      bufB = null;
      rebuildLayout();
      ensureChain(getSnap());
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
