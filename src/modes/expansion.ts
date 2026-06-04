import gsap from 'gsap';
import type opentype from 'opentype.js';
import { DEFAULT_PLAYGROUND_VISUAL } from '../types/playground';
import { colorForGlyph } from '../utils/colors';
import { clearNeutral } from '../utils/canvas';
import { rasterizeGlyphMask, type GlyphSlot } from '../utils/contourField';
import {
  drawFilledContourLayer,
  expandShapeStep,
  extractMaskLoops,
  maskHasInk,
  type ContourChain,
  type ShapeStepParams,
} from '../utils/iterativeContours';
import { fillGlyphPath, strokeGlyphPath } from '../utils/opentypeCanvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

type Lay = { char: string; x: number; bl: number };

const STEPS_PER_FRAME = 5;
const BUILD_BUDGET_MS = 14;

function safeExpansion(s: ModeSnapshot) {
  return { ...DEFAULT_PLAYGROUND_VISUAL.expansion, ...s.visual.expansion };
}

function maskFillColor(stageBackground: string): string | null {
  if (stageBackground === 'transparent') return null;
  return stageBackground;
}

function contourCount(exp: ReturnType<typeof safeExpansion>): number {
  const n = Math.round(exp.contourCount);
  if (!Number.isFinite(n) || n < 1) return 32;
  return Math.min(80, n);
}

function gridCell(exp: ReturnType<typeof safeExpansion>, w: number, h: number) {
  const spacing = Math.max(3, exp.ringSpacing ?? 6);
  let cell = Math.max(1.25, Math.min(3, spacing * 0.22));
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  const maxCells = 320_000;
  if (cw * ch > maxCells) cell = Math.sqrt((w * h) / maxCells);
  return cell;
}

export function createExpansionMode(
  _canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let lays: Lay[] = [];
  let layoutSig = '';
  let cacheSig = '';
  let tickerFn: (() => void) | null = null;

  let chain: ContourChain | null = null;
  let chainReady = false;
  let buildGen = 0;
  let buildingSig: string | null = null;
  let growPhase = 0;
  let growSig = '';
  const fillScratch = document.createElement('canvas');

  const segBuf: { x0: number; y0: number; x1: number; y1: number }[] = [];

  function viewport() {
    const s = getSnap();
    return { w: Math.max(1, Math.round(s.w)), h: Math.max(1, Math.round(s.h)) };
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

  function shapeParams(exp: ReturnType<typeof safeExpansion>, cell: number): ShapeStepParams {
    const spacing = Math.max(3, exp.ringSpacing ?? 6);
    return {
      radiusCells: Math.max(0.6, spacing / cell) * (0.65 + (exp.offsetScale ?? 1) * 0.38),
      baseSmoothPasses: Math.round(1 + (exp.waveFlatten ?? 0.5) * 2),
      baseThreshold: 0.4 - (exp.waveFlatten ?? 0.5) * 0.08,
      waveFlatten: exp.waveFlatten ?? 0.5,
    };
  }

  function scheduleChainBuild(s: ModeSnapshot) {
    const { w, h } = viewport();
    if (w < 32 || h < 32 || lays.length === 0) {
      chain = null;
      chainReady = false;
      buildingSig = null;
      return;
    }

    const exp = safeExpansion(s);
    const count = contourCount(exp);
    const cell = gridCell(exp, w, h);

    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${w}|${h}|${cell}|${count}|${exp.ringSpacing}|${exp.offsetScale}|${exp.waveFlatten}`;
    if (sig === cacheSig && chainReady && chain) return;
    if (sig === buildingSig) return;

    cacheSig = sig;
    buildingSig = sig;
    chainReady = false;
    buildGen++;
    const gen = buildGen;

    try {
      const slots: GlyphSlot[] = lays;
      const raster = rasterizeGlyphMask(w, h, cell, slots, s.fontCss, s.fontSize, s.opentypeFont);
      if (!maskHasInk(raster.mask)) {
        cacheSig = '';
        chain = null;
        chainReady = false;
        buildingSig = null;
        return;
      }

      const params = shapeParams(exp, cell);
      const n = count;

      const masks: Uint8Array[] = [new Uint8Array(raster.mask)];
      const loops = [extractMaskLoops(masks[0]!, raster.cw, raster.ch, cell, segBuf)];

      chain = { masks, loops, cw: raster.cw, ch: raster.ch, cell };

      const distBuf = new Float32Array(raster.mask.length);
      const offsetBuf = new Uint8Array(raster.mask.length);
      const smoothA = new Uint8Array(raster.mask.length);
      const smoothB = new Uint8Array(raster.mask.length);

      let cur = masks[0]!;
      let step = 1;

      const runBatch = () => {
        if (gen !== buildGen) return;

        try {
          const t0 = performance.now();
          while (step < n && performance.now() - t0 < BUILD_BUDGET_MS) {
            let done = 0;
            while (step < n && done < STEPS_PER_FRAME && performance.now() - t0 < BUILD_BUDGET_MS) {
              cur = expandShapeStep(
                cur,
                raster.cw,
                raster.ch,
                step,
                params,
                distBuf,
                offsetBuf,
                smoothA,
                smoothB,
              );
              masks.push(new Uint8Array(cur));
              loops.push(extractMaskLoops(cur, raster.cw, raster.ch, cell, segBuf));
              step++;
              done++;
            }
          }

          if (gen !== buildGen) return;

          if (step >= n) {
            chainReady = true;
            buildingSig = null;
            return;
          }

          requestAnimationFrame(runBatch);
        } catch (err) {
          console.error('[Ripple] build step failed', err);
          buildingSig = null;
        }
      };

      requestAnimationFrame(runBatch);
    } catch (err) {
      console.error('[Ripple] build init failed', err);
      buildingSig = null;
      chain = null;
    }
  }

  function ensureLayout() {
    const s = getSnap();
    const { w, h } = viewport();
    const lay = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${w}|${h}`;
    if (lay !== layoutSig) {
      layoutSig = lay;
      cacheSig = '';
      rebuild();
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

  function drawLetterVector(
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

  function tick() {
    try {
      const s = getSnap();
      const { w, h } = viewport();
      if (w < 32 || h < 32) return;

      ensureLayout();
      scheduleChainBuild(s);
      clearNeutral(ctx, w, h, s.visual.stageBackground);

      if (!chain || lays.length === 0 || chain.masks.length === 0) return;

      const exp = safeExpansion(s);
      const alpha = effectOpacity(s.visual);
      const lw = Math.max(0.5, exp.strokeWidth ?? 1);
      const col = strokeColor(s);
      const bg = maskFillColor(s.visual.stageBackground);
      const layers = chain.masks.length;

      const growKey = cacheSig;
      if (growKey !== growSig) {
        growSig = growKey;
        growPhase = 0;
      }
      if (s.animationEnabled && chainReady) {
        growPhase = Math.min(layers - 0.001, growPhase + (exp.growSpeed ?? 0.28));
      } else {
        growPhase = layers;
      }
      const visibleLayers = Math.min(
        layers,
        Math.max(1, chainReady ? Math.floor(growPhase) + 1 : layers),
      );

      ctx.save();
      ctx.globalCompositeOperation = 'source-over';

      for (let idx = 0; idx < visibleLayers; idx++) {
        if (idx === 0 && s.opentypeFont) {
          drawLetterVector(s, col, lw, alpha, s.opentypeFont, bg);
        } else if (idx === 0) {
          drawFilledContourLayer(
            ctx,
            chain.loops[0] ?? [],
            chain.masks[0]!,
            chain.cw,
            chain.ch,
            chain.cell,
            bg,
            col,
            lw,
            alpha,
            fillScratch,
          );
          continue;
        }
        if (idx === 0) continue;
        drawFilledContourLayer(
          ctx,
          chain.loops[idx] ?? [],
          chain.masks[idx]!,
          chain.cw,
          chain.ch,
          chain.cell,
          bg,
          col,
          lw,
          alpha,
          fillScratch,
        );
      }

      ctx.restore();
    } catch (err) {
      console.error('[Ripple] tick failed', err);
    }
  }

  return {
    start() {
      layoutSig = '';
      cacheSig = '';
      buildingSig = null;
      chain = null;
      chainReady = false;
      buildGen++;
      rebuild();
      scheduleChainBuild(getSnap());
      tickerFn = () => tick();
      gsap.ticker.add(tickerFn);
    },
    stop() {
      if (tickerFn) gsap.ticker.remove(tickerFn);
      tickerFn = null;
      buildGen++;
      buildingSig = null;
    },
    dispose() {
      this.stop();
    },
    interruptInteraction() {},
  };
}
