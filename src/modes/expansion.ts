import gsap from 'gsap';
import type opentype from 'opentype.js';
import { DEFAULT_PLAYGROUND_VISUAL } from '../types/playground';
import { colorForGlyph } from '../utils/colors';
import { clearNeutral } from '../utils/canvas';
import { rasterizeGlyphMask } from '../utils/contourField';
import {
  drawRippleRingLayer,
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

const STEPS_PER_FRAME = 8;
const BUILD_BUDGET_MS = 16;

function safeExpansion(s: ModeSnapshot) {
  return { ...DEFAULT_PLAYGROUND_VISUAL.expansion, ...s.visual.expansion };
}

function maskFillColor(stageBackground: string): string | null {
  if (stageBackground === 'transparent') return null;
  return stageBackground;
}

function contourCount(exp: ReturnType<typeof safeExpansion>): number {
  const n = Math.round(exp.contourCount);
  if (!Number.isFinite(n) || n < 2) return 24;
  return Math.min(120, n);
}

function gridCell(ringSpacing: number, w: number, h: number) {
  const spacing = Math.max(2, ringSpacing);
  let cell = Math.max(1, Math.min(2.5, spacing * 0.2));
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  const maxCells = 400_000;
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
    const spacing = Math.max(2, exp.ringSpacing ?? 5);
    const scale = Math.max(0.35, Math.min(2.5, exp.offsetScale ?? 1));
    return {
      radiusCells: Math.max(0.45, (spacing / cell) * scale),
      baseSmoothPasses: Math.round(1 + (exp.waveFlatten ?? 0.45) * 2),
      baseThreshold: 0.42 - (exp.waveFlatten ?? 0.45) * 0.1,
      waveFlatten: exp.waveFlatten ?? 0.45,
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
    const cell = gridCell(exp.ringSpacing ?? 5, w, h);

    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${w}|${h}|${cell}|${count}|${exp.ringSpacing}|${exp.offsetScale}|${exp.waveFlatten}`;
    if (sig === cacheSig && chainReady && chain) return;
    if (sig === buildingSig) return;

    cacheSig = sig;
    buildingSig = sig;
    chainReady = false;
    buildGen++;
    const gen = buildGen;

    try {
      const raster = rasterizeGlyphMask(w, h, cell, lays, s.fontCss, s.fontSize, s.opentypeFont);
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

      if (!chain || lays.length === 0 || chain.masks.length < 2) return;

      const exp = safeExpansion(s);
      const alpha = effectOpacity(s.visual);
      const lw = Math.max(0.35, exp.strokeWidth ?? 1);
      const col = strokeColor(s);
      const bg = maskFillColor(s.visual.stageBackground);
      const layers = chain.masks.length;
      const anim = s.animationEnabled && !s.visual.sceneFrozen;

      const growKey = cacheSig;
      if (growKey !== growSig) {
        growSig = growKey;
        growPhase = anim ? 1 : layers;
      }
      if (anim && chainReady) {
        growPhase = Math.min(layers, growPhase + (exp.growSpeed ?? 0.35));
      } else if (!anim) {
        growPhase = layers;
      } else {
        growPhase = Math.max(growPhase, chain.masks.length);
      }

      const visibleLayers = Math.min(
        layers,
        Math.max(2, anim && chainReady ? Math.ceil(growPhase) : chain.masks.length),
      );

      ctx.save();
      ctx.globalCompositeOperation = 'source-over';

      if (s.opentypeFont) {
        drawLetterVector(s, col, lw, alpha, s.opentypeFont, bg);
      } else {
        drawRippleRingLayer(
          ctx,
          chain.masks[0]!,
          null,
          chain.loops[0] ?? [],
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

      for (let idx = 1; idx < visibleLayers; idx++) {
        drawRippleRingLayer(
          ctx,
          chain.masks[idx]!,
          chain.masks[idx - 1]!,
          chain.loops[idx] ?? [],
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
      growPhase = 0;
      growSig = '';
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
