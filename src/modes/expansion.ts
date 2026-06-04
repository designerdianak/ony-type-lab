import gsap from 'gsap';
import { DEFAULT_PLAYGROUND_VISUAL } from '../types/playground';
import { colorForGlyph } from '../utils/colors';
import { clearNeutral } from '../utils/canvas';
import { rasterizeGlyphMask, type GlyphSlot } from '../utils/contourField';
import {
  drawFilledContourLayer,
  expandShapeStep,
  extractMaskLoops,
  type ContourChain,
  type ShapeStepParams,
} from '../utils/iterativeContours';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

type Lay = { char: string; x: number; bl: number };

const STEPS_PER_FRAME = 4;
const BUILD_BUDGET_MS = 12;
const MAX_CONTOURS = 80;
const MAX_GRID_CELLS = 280_000;

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
  return Math.min(MAX_CONTOURS, n);
}

function gridCell(exp: ReturnType<typeof safeExpansion>, w: number, h: number) {
  let cell = Math.max(2, Math.min(4, exp.ringSpacing * 0.32));
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  if (cw * ch > MAX_GRID_CELLS) {
    cell = Math.sqrt((w * h) / MAX_GRID_CELLS);
  }
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

  const segBuf: { x0: number; y0: number; x1: number; y1: number }[] = [];

  function viewport() {
    const s = getSnap();
    return { w: Math.max(1, Math.round(s.w)), h: Math.max(1, Math.round(s.h)) };
  }

  function rebuild() {
    const s = getSnap();
    const { w, h } = viewport();
    const tw = measureLineWidth(ctx, s.text, s.fontCss, s.letterSpacing);
    const ox = (w - tw) * 0.5;
    const oy = h * 0.55;
    const g = layoutGlyphs(ctx, s.text, s.fontCss, s.fontSize, s.letterSpacing, ox, oy);
    lays = g.map((lg) => ({ char: lg.char, x: lg.x, bl: lg.baseline }));
  }

  function shapeParams(exp: ReturnType<typeof safeExpansion>, cell: number): ShapeStepParams {
    const spacing = Math.max(3, exp.ringSpacing ?? 6);
    return {
      radiusCells: Math.max(0.75, spacing / cell) * (0.7 + (exp.offsetScale ?? 1) * 0.4),
      baseSmoothPasses: Math.round(1 + (exp.waveFlatten ?? 0.5) * 2),
      baseThreshold: 0.44 - (exp.waveFlatten ?? 0.5) * 0.1,
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
          chainReady = false;
        }
      };

      requestAnimationFrame(runBatch);
    } catch (err) {
      console.error('[Ripple] build init failed', err);
      buildingSig = null;
      chain = null;
      chainReady = false;
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
      const lw = Math.max(0.35, exp.strokeWidth ?? 1);
      const col = strokeColor(s);
      const bg = maskFillColor(s.visual.stageBackground);
      const layers = chain.masks.length;

      ctx.save();
      ctx.globalCompositeOperation = 'source-over';

      for (let idx = 0; idx < layers; idx++) {
        drawFilledContourLayer(ctx, chain.loops[idx] ?? [], bg, col, lw, alpha);
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
