import gsap from 'gsap';
import type opentype from 'opentype.js';
import { DEFAULT_PLAYGROUND_VISUAL, type ExpansionSettings } from '../types/playground';
import { clearNeutral } from '../utils/canvas';
import { rasterizeGlyphMask, type GlyphSlot } from '../utils/contourField';
import {
  drawFilledGenerationRange,
  expandMaskGenerationInto,
  maskHasInk,
} from '../utils/iterativeContours';
import { fillGlyphPath } from '../utils/opentypeCanvas';
import { layoutTextForCanvas } from '../utils/textLayout';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

type Lay = { char: string; x: number; bl: number };

const FLOW_RATE = 9;
const MAX_COPIES = 120;
const MIN_COPIES = 4;
const GC_MARGIN = 2;

function safeExpansion(s: ModeSnapshot) {
  return { ...DEFAULT_PLAYGROUND_VISUAL.expansion, ...s.visual.expansion };
}

/** N копий в потоке — только они строятся и рисуются. */
function copyCount(exp: ReturnType<typeof safeExpansion>): number {
  const n = Math.round(exp.contourCount);
  return Math.min(MAX_COPIES, Math.max(MIN_COPIES, Number.isFinite(n) ? n : 40));
}

/** Дальность потока ≈ край экрана; шаг = reach / N × множитель «Расстояние». */
function screenReach(w: number, h: number): number {
  return Math.max(w, h) * 0.52;
}

function baseStepPx(exp: ReturnType<typeof safeExpansion>, w: number, h: number, n: number): number {
  const reach = screenReach(w, h);
  const spacingMul = Math.max(0.5, exp.ringSpacing ?? 4) / 4;
  return (reach / Math.max(MIN_COPIES, n)) * spacingMul * (0.65 + (exp.offsetScale ?? 1) * 0.45);
}

function baseRadiusCells(
  exp: ReturnType<typeof safeExpansion>,
  cell: number,
  w: number,
  h: number,
  n: number,
): number {
  return Math.max(1, baseStepPx(exp, w, h, n) / cell);
}

function gridCell(exp: ReturnType<typeof safeExpansion>, w: number, h: number, n: number) {
  const step = baseStepPx(exp, w, h, n);
  const cell = Math.max(1.5, Math.min(3, step * 0.32));
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  const maxCells = 480_000;
  if (cw * ch > maxCells) return Math.sqrt((w * h) / maxCells);
  return cell;
}

function rasterPadding(exp: ReturnType<typeof safeExpansion>, w: number, h: number, n: number): number {
  const reach = baseStepPx(exp, w, h, n) * n * 1.15;
  return Math.ceil(reach + Math.max(w, h) * 0.12);
}

function stageFill(stageBackground: string): string | null {
  return stageBackground === 'transparent' ? null : stageBackground;
}

function ripplePalette(exp: ExpansionSettings): string[] {
  if (exp.rippleColorMode === 'custom') {
    const cols = exp.customColors.filter((c) => c && c.length > 0);
    if (cols.length > 0) return cols;
  }
  return [exp.colorA, exp.colorB];
}

function colorForGeneration(exp: ExpansionSettings, gen: number): string {
  const pal = ripplePalette(exp);
  return pal[(gen - 1) % pal.length]!;
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

  /** Shape0…ShapeK — только нужные поколения (rolling cache). */
  const maskByGen = new Map<number, Uint8Array>();
  let highestGen = 0;
  let chainSig = '';

  let gridCw = 0;
  let gridCh = 0;
  let gridCellPx = 2;
  let gridPad = 0;
  let buildRadius = 1;
  let copiesN = 40;

  let expandBufA: Uint8Array | null = null;
  let expandBufB: Uint8Array | null = null;

  let flowPhase = 0;
  let flowHead = 0;
  let tickerFn: (() => void) | null = null;

  const fillScratch = document.createElement('canvas');

  function viewport() {
    const s = getSnap();
    return { w: Math.max(1, Math.round(s.w)), h: Math.max(1, Math.round(s.h)) };
  }

  function rippleOpts(s: ModeSnapshot) {
    const exp = safeExpansion(s);
    return {
      waveFlatten: exp.waveFlatten ?? 0.5,
      spacingMode: exp.spacingMode ?? 'uniform',
      spacingSpread: exp.spacingSpread ?? 0.08,
      edgeMode: exp.edgeMode ?? 'smoothNearText',
    };
  }

  function rebuildLayout() {
    const s = getSnap();
    const { w, h } = viewport();
    const text = s.text.trim();
    if (!text) {
      lays = [];
      return;
    }
    const block = layoutTextForCanvas(
      ctx,
      text,
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
    for (const g of maskByGen.keys()) {
      if (g > 0 && g < minGen) maskByGen.delete(g);
    }
  }

  function expandOne(s: ModeSnapshot, gen: number, prev: Uint8Array): Uint8Array {
    if (!expandBufA || expandBufA.length !== prev.length) {
      expandBufA = new Uint8Array(prev.length);
      expandBufB = new Uint8Array(prev.length);
    }
    expandMaskGenerationInto(
      prev,
      expandBufA,
      gen,
      gridCw,
      gridCh,
      buildRadius,
      rippleOpts(s).waveFlatten,
      rippleOpts(s).spacingMode,
      rippleOpts(s).spacingSpread,
      rippleOpts(s).edgeMode,
      copiesN,
      expandBufB ?? undefined,
    );
    return new Uint8Array(expandBufA);
  }

  /** Shapeₙ = Offset(Smooth(Shapeₙ₋₁)) — последовательно до targetGen. */
  function ensureGeneration(s: ModeSnapshot, targetGen: number) {
    if (targetGen <= highestGen) return;

    while (highestGen < targetGen) {
      const next = highestGen + 1;
      const prev = maskByGen.get(highestGen);
      if (!prev) break;
      maskByGen.set(next, expandOne(s, next, prev));
      highestGen = next;
    }
  }

  function rebuildChain(s: ModeSnapshot) {
    const { w, h } = viewport();
    maskByGen.clear();
    highestGen = 0;
    expandBufA = null;
    expandBufB = null;

    if (w < 32 || h < 32 || lays.length === 0) return;

    const exp = safeExpansion(s);
    copiesN = copyCount(exp);
    const cell = gridCell(exp, w, h, copiesN);
    const pad = rasterPadding(exp, w, h, copiesN);
    buildRadius = baseRadiusCells(exp, cell, w, h, copiesN);
    gridCellPx = cell;
    gridPad = pad;

    const rw = w + pad * 2;
    const rh = h + pad * 2;
    const slots: GlyphSlot[] = lays.map((g) => ({
      char: g.char,
      x: g.x + pad,
      bl: g.bl + pad,
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
    maskByGen.set(0, new Uint8Array(raster.mask));

    ensureGeneration(s, copiesN);
  }

  function ensureChain(s: ModeSnapshot) {
    const { w, h } = viewport();
    if (w < 32 || h < 32 || lays.length === 0) {
      maskByGen.clear();
      highestGen = 0;
      return;
    }

    const exp = safeExpansion(s);
    const n = copyCount(exp);
    const cell = gridCell(exp, w, h, n);
    const pad = rasterPadding(exp, w, h, n);
    const radius = baseRadiusCells(exp, cell, w, h, n);

    const sig = `${layoutSig}|${n}|${cell}|${pad}|${radius}|${exp.ringSpacing}|${exp.offsetScale}|${exp.waveFlatten}|${exp.spacingMode}|${exp.spacingSpread}|${exp.edgeMode}`;
    if (sig === chainSig && maskByGen.has(0) && highestGen >= n) return;

    chainSig = sig;
    flowPhase = 0;
    flowHead = 0;
    rebuildChain(s);
  }

  function drawShape0Text(fill: string | null, alpha: number, font: opentype.Font) {
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

      const n = copyCount(safeExpansion(s));
      if (!maskByGen.has(0) || highestGen < 1 || lays.length === 0) return;

      const exp = safeExpansion(s);
      const alpha = effectOpacity(s.visual);
      const textFill = stageFill(s.visual.stageBackground);
      const anim = s.animationEnabled && !s.visual.sceneFrozen;

      let firstGen = 1;
      let lastGen = n;

      if (anim) {
        flowPhase += (exp.growSpeed ?? 0.55) * (gsap.ticker.deltaRatio() / 60) * FLOW_RATE;
        const head = Math.floor(flowPhase);
        if (head !== flowHead) {
          flowHead = head;
          ensureGeneration(s, flowHead + n);
          gcBelow(flowHead - GC_MARGIN);
        }
        firstGen = flowHead + 1;
        lastGen = flowHead + n;
        ensureGeneration(s, lastGen);
      }

      ctx.save();
      ctx.globalCompositeOperation = 'source-over';

      drawFilledGenerationRange(
        ctx,
        (g) => maskByGen.get(g) ?? null,
        firstGen,
        lastGen,
        gridCw,
        gridCh,
        gridCellPx,
        -gridPad,
        -gridPad,
        (gen) => colorForGeneration(exp, gen),
        alpha,
        fillScratch,
      );

      if (s.opentypeFont) {
        drawShape0Text(textFill, alpha, s.opentypeFont);
      }

      ctx.restore();
    } catch (err) {
      console.error('[Ripple] tick failed', err);
    }
  }

  return {
    start() {
      layoutSig = '';
      chainSig = '';
      maskByGen.clear();
      highestGen = 0;
      flowPhase = 0;
      flowHead = 0;
      expandBufA = null;
      expandBufB = null;
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
