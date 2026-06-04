import gsap from 'gsap';
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

const STEPS_PER_FRAME = 6;
const BUILD_BUDGET_MS = 14;

function maskFillColor(stageBackground: string): string | null {
  if (stageBackground === 'transparent') return null;
  return stageBackground;
}

function contourCount(exp: ModeSnapshot['visual']['expansion']): number {
  const n = Math.round(exp.contourCount);
  if (!Number.isFinite(n) || n < 1) return 48;
  return Math.min(150, n);
}

export function createExpansionMode(
  canvas: HTMLCanvasElement,
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
  const fillScratch = document.createElement('canvas');

  const segBuf: { x0: number; y0: number; x1: number; y1: number }[] = [];

  function readViewport() {
    const r = canvas.getBoundingClientRect();
    return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
  }

  function rebuild() {
    const s = getSnap();
    const { w, h } = readViewport();
    const tw = measureLineWidth(ctx, s.text, s.fontCss, s.letterSpacing);
    const ox = (w - tw) * 0.5;
    const oy = h * 0.55;
    const g = layoutGlyphs(ctx, s.text, s.fontCss, s.fontSize, s.letterSpacing, ox, oy);
    lays = g.map((lg) => ({ char: lg.char, x: lg.x, bl: lg.baseline }));
  }

  function shapeParams(s: ModeSnapshot, cell: number): ShapeStepParams {
    const exp = s.visual.expansion;
    const spacing = Math.max(3, exp.ringSpacing);
    return {
      radiusCells: Math.max(0.75, spacing / cell) * (0.7 + exp.offsetScale * 0.4),
      baseSmoothPasses: Math.round(1 + exp.waveFlatten * 2),
      baseThreshold: 0.44 - exp.waveFlatten * 0.1,
      waveFlatten: exp.waveFlatten,
    };
  }

  function scheduleChainBuild(s: ModeSnapshot) {
    const { w, h } = readViewport();
    if (w < 32 || h < 32 || lays.length === 0) {
      chain = null;
      chainReady = false;
      return;
    }

    const exp = s.visual.expansion;
    const count = contourCount(exp);
    const cell = Math.max(
      1.5,
      Math.min(3.25, exp.ringSpacing * (0.3 + Math.min(count, 80) * 0.004)),
    );

    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${w}|${h}|${cell}|${count}|${exp.ringSpacing}|${exp.offsetScale}|${exp.waveFlatten}`;
    if (sig === cacheSig && chainReady && chain) return;

    cacheSig = sig;
    chainReady = false;
    buildGen++;
    const gen = buildGen;

    const slots: GlyphSlot[] = lays;
    const raster = rasterizeGlyphMask(w, h, cell, slots, s.fontCss, s.fontSize, s.opentypeFont);
    const params = shapeParams(s, cell);
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
        return;
      }

      requestAnimationFrame(runBatch);
    };

    requestAnimationFrame(runBatch);
  }

  function ensure() {
    const s = getSnap();
    const { w, h } = readViewport();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${w}|${h}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      cacheSig = '';
      rebuild();
    }
    scheduleChainBuild(s);
  }

  function strokeColor(s: ModeSnapshot) {
    const exp = s.visual.expansion;
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
    const s = getSnap();
    const { w, h } = readViewport();
    if (w < 32 || h < 32) return;

    ensure();
    clearNeutral(ctx, w, h, s.visual.stageBackground);
    if (!chain || lays.length === 0 || chain.masks.length === 0) return;

    const alpha = effectOpacity(s.visual);
    const lw = Math.max(0.35, s.visual.expansion.strokeWidth);
    const col = strokeColor(s);
    const bg = maskFillColor(s.visual.stageBackground);
    const layers = chain.masks.length;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    for (let idx = 0; idx < layers; idx++) {
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
  }

  return {
    start() {
      layoutSig = '';
      cacheSig = '';
      chain = null;
      chainReady = false;
      buildGen++;
      readViewport();
      rebuild();
      scheduleChainBuild(getSnap());
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
