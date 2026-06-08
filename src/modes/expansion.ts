import gsap from 'gsap';
import type opentype from 'opentype.js';
import { DEFAULT_PLAYGROUND_VISUAL, type ExpansionSettings } from '../types/playground';
import { clearNeutral } from '../utils/canvas';
import { rasterizeGlyphMask, type GlyphSlot } from '../utils/contourField';
import { drawFilledGenerationRange, maskHasInk } from '../utils/iterativeContours';
import { fillGlyphPath } from '../utils/opentypeCanvas';
import {
  expandRippleStepInto,
  RIPPLE_FLOW_SPEED,
  rippleBaseRadiusCells,
  rippleColorAt,
  rippleGridCell,
  rippleRasterPad,
  rippleScreenReach,
} from '../utils/rippleOffset';
import { layoutTextForCanvas } from '../utils/textLayout';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

type Lay = { char: string; x: number; bl: number };

const MIN_COPIES = 2;
const MAX_COPIES = 200;
const GC_MARGIN = 2;

function safeExpansion(s: ModeSnapshot): ExpansionSettings {
  return { ...DEFAULT_PLAYGROUND_VISUAL.expansion, ...s.visual.expansion };
}

function copyCount(exp: ExpansionSettings): number {
  const n = Math.round(exp.contourCount);
  return Math.min(MAX_COPIES, Math.max(MIN_COPIES, Number.isFinite(n) ? n : 24));
}

function stageFill(stageBackground: string): string | null {
  return stageBackground === 'transparent' ? null : stageBackground;
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

  const masks = new Map<number, Uint8Array>();
  let highestGen = 0;
  let chainSig = '';
  let copiesN = 24;

  let gridCw = 0;
  let gridCh = 0;
  let gridCellPx = 2;
  let gridPad = 0;
  let baseRadius = 1;

  let bufA: Uint8Array | null = null;
  let bufB: Uint8Array | null = null;

  let flowPhase = 0;
  let flowHead = 0;
  let tickerFn: (() => void) | null = null;
  const fillScratch = document.createElement('canvas');

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
    for (const g of masks.keys()) {
      if (g > 0 && g < minGen) masks.delete(g);
    }
  }

  function expandOne(exp: ExpansionSettings, gen: number, prev: Uint8Array): Uint8Array {
    if (!bufA || bufA.length !== prev.length) {
      bufA = new Uint8Array(prev.length);
      bufB = new Uint8Array(prev.length);
    }
    expandRippleStepInto(
      prev,
      bufA,
      gen,
      gridCw,
      gridCh,
      baseRadius,
      exp.spacingMode,
      exp.spacingSpread,
      exp.flowBiasX,
      exp.flowBiasY,
      bufB ?? undefined,
    );
    return new Uint8Array(bufA);
  }

  function ensureGeneration(exp: ExpansionSettings, target: number) {
    while (highestGen < target) {
      const next = highestGen + 1;
      const prev = masks.get(highestGen);
      if (!prev) break;
      masks.set(next, expandOne(exp, next, prev));
      highestGen = next;
    }
  }

  function rebuildChain(s: ModeSnapshot) {
    const { w, h } = viewport();
    masks.clear();
    highestGen = 0;
    bufA = null;
    bufB = null;

    if (w < 32 || h < 32 || lays.length === 0) return;

    const exp = safeExpansion(s);
    copiesN = copyCount(exp);
    const reach = rippleScreenReach(w, h, exp.flowBiasX, exp.flowBiasY);
    const stepPx = reach / copiesN;
    const cell = rippleGridCell(stepPx, w, h);
    gridPad = rippleRasterPad(reach, w, h);
    baseRadius = rippleBaseRadiusCells(w, h, copiesN, cell, exp.flowBiasX, exp.flowBiasY);
    gridCellPx = cell;

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
      cell,
      slots,
      layoutFontCss || s.fontCss,
      layoutFontSize,
      s.opentypeFont,
    );
    if (!maskHasInk(raster.mask)) return;

    gridCw = raster.cw;
    gridCh = raster.ch;
    masks.set(0, new Uint8Array(raster.mask));
    ensureGeneration(exp, copiesN);
  }

  function ensureChain(s: ModeSnapshot) {
    const { w, h } = viewport();
    if (w < 32 || h < 32 || lays.length === 0) {
      masks.clear();
      highestGen = 0;
      return;
    }

    const exp = safeExpansion(s);
    const n = copyCount(exp);
    const reach = rippleScreenReach(w, h, exp.flowBiasX, exp.flowBiasY);
    const stepPx = reach / n;
    const cell = rippleGridCell(stepPx, w, h);
    const pad = rippleRasterPad(reach, w, h);
    const radius = rippleBaseRadiusCells(w, h, n, cell, exp.flowBiasX, exp.flowBiasY);

    const sig = [
      layoutSig,
      n,
      cell,
      pad,
      radius,
      exp.spacingMode,
      exp.spacingSpread,
      exp.flowBiasX,
      exp.flowBiasY,
      exp.rippleColorMode,
      exp.colorA,
      exp.colorB,
      exp.customColors.join(','),
    ].join('|');

    if (sig === chainSig && masks.has(0) && highestGen >= n) return;

    chainSig = sig;
    flowPhase = 0;
    flowHead = 0;
    rebuildChain(s);
  }

  function drawTextHole(fill: string | null, alpha: number, font: opentype.Font) {
    ctx.save();
    ctx.globalAlpha = alpha;
    for (const g of lays) {
      const path = font.getPath(g.char, g.x, g.bl, layoutFontSize);
      if (fill) fillGlyphPath(ctx, path, fill);
      else {
        ctx.globalCompositeOperation = 'destination-out';
        fillGlyphPath(ctx, path, 'rgba(0,0,0,1)');
        ctx.globalCompositeOperation = 'source-over';
      }
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

      const exp = safeExpansion(s);
      const n = copyCount(exp);
      if (!masks.has(0) || highestGen < 1 || lays.length === 0) return;

      const alpha = effectOpacity(s.visual);
      const textFill = stageFill(s.visual.stageBackground);
      const frozen = s.visual.sceneFrozen;

      let firstGen = 1;
      let lastGen = n;

      if (!frozen) {
        flowPhase += RIPPLE_FLOW_SPEED * (gsap.ticker.deltaRatio() / 60) * 9;
        const head = Math.floor(flowPhase);
        if (head !== flowHead) {
          flowHead = head;
          ensureGeneration(exp, head + n);
          gcBelow(head - GC_MARGIN);
        }
        firstGen = head + 1;
        lastGen = head + n;
        ensureGeneration(exp, lastGen);
      }

      ctx.save();
      drawFilledGenerationRange(
        ctx,
        (g) => masks.get(g) ?? null,
        firstGen,
        lastGen,
        gridCw,
        gridCh,
        gridCellPx,
        -gridPad,
        -gridPad,
        (g) => rippleColorAt(exp, g),
        alpha,
        fillScratch,
      );
      if (s.opentypeFont) drawTextHole(textFill, alpha, s.opentypeFont);
      ctx.restore();
    } catch (err) {
      console.error('[Ripple] tick failed', err);
    }
  }

  return {
    start() {
      layoutSig = '';
      chainSig = '';
      masks.clear();
      highestGen = 0;
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
