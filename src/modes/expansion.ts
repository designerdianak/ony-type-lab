import gsap from 'gsap';
import type opentype from 'opentype.js';
import { DEFAULT_PLAYGROUND_VISUAL } from '../types/playground';
import { colorForGlyph } from '../utils/colors';
import { clearNeutral } from '../utils/canvas';
import { rasterizeGlyphMask, type GlyphSlot } from '../utils/contourField';
import {
  drawContourGenerationStack,
  drawMaskContourLayer,
  expandMaskGeneration,
  maskHasInk,
} from '../utils/iterativeContours';
import { fillGlyphPath, strokeGlyphPath } from '../utils/opentypeCanvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

type Lay = { char: string; x: number; bl: number };

const FLOW_RATE = 11;
const MAX_ADVANCE_PER_FRAME = 4;
const STATIC_BUILD_BATCH = 12;
const STATIC_BUILD_BUDGET_MS = 24;

function safeExpansion(s: ModeSnapshot) {
  return { ...DEFAULT_PLAYGROUND_VISUAL.expansion, ...s.visual.expansion };
}

function windowSize(exp: ReturnType<typeof safeExpansion>): number {
  const n = Math.round(exp.contourCount);
  return Math.min(150, Math.max(4, Number.isFinite(n) ? n : 40));
}

function staticTotal(exp: ReturnType<typeof safeExpansion>, w: number, h: number): number {
  const spacing = Math.max(2, exp.ringSpacing ?? 4);
  const toEdge = Math.ceil(Math.max(w, h) / spacing) + 24;
  return Math.min(200, Math.max(windowSize(exp), toEdge));
}

function stepParams(exp: ReturnType<typeof safeExpansion>, cell: number) {
  const spacing = Math.max(2, exp.ringSpacing ?? 4);
  const radiusCells = Math.max(1, spacing / cell) * (0.65 + (exp.offsetScale ?? 1) * 0.45);
  return { radiusCells };
}

function gridCell(exp: ReturnType<typeof safeExpansion>, w: number, h: number) {
  const spacing = Math.max(2, exp.ringSpacing ?? 4);
  const cell = Math.max(1.25, Math.min(2.5, spacing * 0.38));
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  const maxCells = 720_000;
  if (cw * ch > maxCells) return Math.sqrt((w * h) / maxCells);
  return cell;
}

function rasterPadding(total: number, spacing: number, w: number, h: number): number {
  const reach = (total - 1) * spacing * 1.4;
  return Math.ceil(Math.max(reach * 0.55, Math.max(w, h) * 0.4) + spacing * 8);
}

function stageFill(stageBackground: string): string | null {
  return stageBackground === 'transparent' ? null : stageBackground;
}

export function createExpansionMode(
  _canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let lays: Lay[] = [];
  let layoutSig = '';
  let rasterSig = '';
  let tickerFn: (() => void) | null = null;

  let glyphMask: Uint8Array | null = null;
  let advanceMask: Uint8Array | null = null;
  let advanceRing = 0;

  let staticMasks: Uint8Array[] = [];
  let staticBuildStep = 0;
  let staticTarget = 32;
  let staticReady = false;
  let buildGen = 0;

  let gridCw = 0;
  let gridCh = 0;
  let gridCellPx = 2;
  let gridPad = 0;
  let buildRadius = 1;

  let flowPhase = 0;
  let flowSig = '';

  const fillScratch = document.createElement('canvas');
  const segBuf: { x0: number; y0: number; x1: number; y1: number }[] = [];

  function viewport() {
    const s = getSnap();
    return { w: Math.max(1, Math.round(s.w)), h: Math.max(1, Math.round(s.h)) };
  }

  function rippleOpts(s: ModeSnapshot, farGen: number) {
    const exp = safeExpansion(s);
    return {
      waveFlatten: exp.waveFlatten ?? 0.5,
      spacingMode: exp.spacingMode ?? 'uniform',
      spacingSpread: exp.spacingSpread ?? 0.08,
      edgeMode: exp.edgeMode ?? 'smoothNearText',
      farGen,
    };
  }

  function rebuild() {
    const s = getSnap();
    const { w, h } = viewport();
    const text = s.text.trim();
    if (!text) {
      lays = [];
      return;
    }
    const tw = measureLineWidth(ctx, text, s.fontCss, s.letterSpacing);
    const ox = (w - tw) * 0.5;
    const oy = h * 0.55;
    const g = layoutGlyphs(ctx, text, s.fontCss, s.fontSize, s.letterSpacing, ox, oy);
    lays = g.map((lg) => ({ char: lg.char, x: lg.x, bl: lg.baseline }));
  }

  function resetRasterState() {
    glyphMask = null;
    advanceMask = null;
    advanceRing = 0;
    staticMasks = [];
    staticBuildStep = 0;
    staticReady = false;
    flowPhase = 0;
    flowSig = '';
    buildGen++;
  }

  function ensureRaster(s: ModeSnapshot) {
    const { w, h } = viewport();
    if (w < 32 || h < 32 || lays.length === 0) {
      resetRasterState();
      return;
    }

    const exp = safeExpansion(s);
    const anim = s.animationEnabled && !s.visual.sceneFrozen;
    const total = anim ? windowSize(exp) + 48 : staticTotal(exp, w, h);
    const cell = gridCell(exp, w, h);
    const spacing = Math.max(2, exp.ringSpacing ?? 4);
    const pad = rasterPadding(total, spacing, w, h);
    const { radiusCells } = stepParams(exp, cell);

    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${w}|${h}|${cell}|${total}|${pad}|${anim}|${exp.ringSpacing}|${exp.offsetScale}|${exp.waveFlatten}|${exp.spacingMode}|${exp.spacingSpread}|${exp.edgeMode}`;
    if (sig === rasterSig && glyphMask) return;

    rasterSig = sig;
    resetRasterState();
    buildRadius = radiusCells;
    gridCellPx = cell;
    gridPad = pad;
    staticTarget = staticTotal(exp, w, h);

    try {
      const rw = w + pad * 2;
      const rh = h + pad * 2;
      const slots: GlyphSlot[] = lays.map((g) => ({
        char: g.char,
        x: g.x + pad,
        bl: g.bl + pad,
      }));
      const raster = rasterizeGlyphMask(rw, rh, cell, slots, s.fontCss, s.fontSize, s.opentypeFont);
      if (!maskHasInk(raster.mask)) return;

      gridCw = raster.cw;
      gridCh = raster.ch;
      glyphMask = raster.mask;
      advanceMask = new Uint8Array(glyphMask);
      advanceRing = 0;

      if (!anim) {
        staticMasks = [new Uint8Array(glyphMask)];
        staticBuildStep = 1;
        const gen = buildGen;
        const runStatic = () => {
          if (gen !== buildGen || !glyphMask) return;
          const t0 = performance.now();
          const opts = rippleOpts(s, staticTarget);
          while (
            staticBuildStep < staticTarget &&
            performance.now() - t0 < STATIC_BUILD_BUDGET_MS
          ) {
            let n = 0;
            while (
              staticBuildStep < staticTarget &&
              n < STATIC_BUILD_BATCH &&
              performance.now() - t0 < STATIC_BUILD_BUDGET_MS
            ) {
              const prev = staticMasks[staticMasks.length - 1]!;
              staticMasks.push(
                expandMaskGeneration(
                  prev,
                  staticBuildStep,
                  gridCw,
                  gridCh,
                  buildRadius,
                  opts.waveFlatten,
                  opts.spacingMode,
                  opts.spacingSpread,
                  opts.edgeMode,
                  staticTarget,
                ),
              );
              staticBuildStep++;
              n++;
            }
          }
          if (gen !== buildGen) return;
          if (staticBuildStep >= staticTarget) {
            staticReady = true;
            return;
          }
          requestAnimationFrame(runStatic);
        };
        requestAnimationFrame(runStatic);
      }
    } catch (err) {
      console.error('[Ripple] raster failed', err);
      resetRasterState();
    }
  }

  function ensureLayout() {
    const s = getSnap();
    const { w, h } = viewport();
    const lay = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${w}|${h}`;
    if (lay !== layoutSig) {
      layoutSig = lay;
      rasterSig = '';
      rebuild();
    }
  }

  function advanceToward(targetRing: number, s: ModeSnapshot, farGen: number) {
    if (!glyphMask || !advanceMask) return;
    const opts = rippleOpts(s, farGen);
    let steps = 0;
    while (advanceRing < targetRing && steps < MAX_ADVANCE_PER_FRAME) {
      advanceMask = expandMaskGeneration(
        advanceMask,
        advanceRing + 1,
        gridCw,
        gridCh,
        buildRadius,
        opts.waveFlatten,
        opts.spacingMode,
        opts.spacingSpread,
        opts.edgeMode,
        farGen,
      );
      advanceRing++;
      steps++;
    }
  }

  function strokeColor(s: ModeSnapshot) {
    const exp = safeExpansion(s);
    if (exp.strokeColor !== 'auto' && exp.strokeColor) return exp.strokeColor;
    return colorForGlyph({
      mode: s.visual.colorMode,
      monochrome: s.visual.monochromeColor,
      seed: s.visual.rainbowSeed,
      index: 0,
      total: lays.length + 2,
    });
  }

  function drawShape0Text(
    s: ModeSnapshot,
    col: string,
    lw: number,
    alpha: number,
    font: opentype.Font,
    fill: string | null,
  ) {
    const fs = s.fontSize;
    ctx.save();
    ctx.globalAlpha = alpha;
    for (const g of lays) {
      const path = font.getPath(g.char, g.x, g.bl, fs);
      if (fill) fillGlyphPath(ctx, path, fill);
      else {
        ctx.globalCompositeOperation = 'destination-out';
        fillGlyphPath(ctx, path, 'rgba(0,0,0,1)');
        ctx.globalCompositeOperation = 'source-over';
      }
      strokeGlyphPath(ctx, path, col, lw);
    }
    ctx.restore();
  }

  /** Бесконечный поток: окно колец [head+1 … head+window], как visibility в Cavalry. */
  function drawFlowWindow(
    s: ModeSnapshot,
    head: number,
    win: number,
    col: string,
    lw: number,
    alpha: number,
    fill: string | null,
  ) {
    if (!glyphMask || !advanceMask) return;

    advanceToward(head, s, head + win + 8);

    const opts = rippleOpts(s, head + win);
    let m = new Uint8Array(advanceMask);

    ctx.save();
    ctx.translate(-gridPad, -gridPad);
    ctx.globalCompositeOperation = 'source-over';

    for (let vi = 0; vi < win; vi++) {
      const gen = head + vi + 1;
      if (maskHasInk(m)) {
        drawMaskContourLayer(
          ctx,
          m,
          gridCw,
          gridCh,
          gridCellPx,
          fill,
          col,
          lw,
          alpha,
          segBuf,
          fillScratch,
        );
      }
      m = expandMaskGeneration(
        m,
        gen + 1,
        gridCw,
        gridCh,
        buildRadius,
        opts.waveFlatten,
        opts.spacingMode,
        opts.spacingSpread,
        opts.edgeMode,
        head + win,
      );
    }

    ctx.restore();
  }

  function tick() {
    try {
      const s = getSnap();
      const { w, h } = viewport();
      if (w < 32 || h < 32) return;

      ensureLayout();
      ensureRaster(s);
      clearNeutral(ctx, w, h, s.visual.stageBackground);

      if (!glyphMask || lays.length === 0) return;

      const exp = safeExpansion(s);
      const alpha = effectOpacity(s.visual);
      const lw = Math.max(0.35, exp.strokeWidth ?? 1);
      const fill = stageFill(s.visual.stageBackground);
      const col = strokeColor(s);
      const anim = s.animationEnabled && !s.visual.sceneFrozen;
      const win = windowSize(exp);

      if (rasterSig !== flowSig) {
        flowSig = rasterSig;
        flowPhase = 0;
      }

      ctx.save();
      ctx.globalCompositeOperation = 'source-over';

      if (anim) {
        flowPhase += (exp.growSpeed ?? 0.55) * (gsap.ticker.deltaRatio() / 60) * FLOW_RATE;
        const head = Math.floor(flowPhase);
        drawFlowWindow(s, head, win, col, lw, alpha, fill);
      } else if (staticMasks.length > 1) {
        const last = staticReady
          ? staticMasks.length - 1
          : Math.max(1, staticMasks.length - 1);
        drawContourGenerationStack(
          ctx,
          staticMasks,
          1,
          last,
          gridCw,
          gridCh,
          gridCellPx,
          -gridPad,
          -gridPad,
          fill,
          col,
          lw,
          alpha,
          segBuf,
          fillScratch,
        );
      }

      if (s.opentypeFont) {
        drawShape0Text(s, col, lw, alpha, s.opentypeFont, fill);
      }

      ctx.restore();
    } catch (err) {
      console.error('[Ripple] tick failed', err);
    }
  }

  return {
    start() {
      layoutSig = '';
      rasterSig = '';
      resetRasterState();
      rebuild();
      ensureRaster(getSnap());
      tickerFn = () => tick();
      gsap.ticker.add(tickerFn);
    },
    stop() {
      if (tickerFn) gsap.ticker.remove(tickerFn);
      tickerFn = null;
      buildGen++;
    },
    dispose() {
      this.stop();
    },
    interruptInteraction() {},
  };
}
