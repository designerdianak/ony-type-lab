import gsap from 'gsap';
import { colorForGlyph } from '../utils/colors';
import { clearNeutral } from '../utils/canvas';
import { rasterizeGlyphMask, type GlyphSlot } from '../utils/contourField';
import {
  buildContourChain,
  drawFilledContourLayer,
  type ContourChain,
  type ShapeStepParams,
} from '../utils/iterativeContours';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

type Lay = { char: string; x: number; bl: number };

function maskFillColor(stageBackground: string): string | null {
  if (stageBackground === 'transparent') return null;
  return stageBackground;
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

  function rebuildChain(s: ModeSnapshot) {
    const { w, h } = readViewport();
    if (w < 32 || h < 32 || lays.length === 0) {
      chain = null;
      return;
    }

    const exp = s.visual.expansion;
    const count = Math.max(1, Math.min(150, Math.round(exp.contourCount)));
    const cell = Math.max(
      1.5,
      Math.min(3.25, exp.ringSpacing * (0.3 + Math.min(count, 80) * 0.004)),
    );

    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${w}|${h}|${cell}|${count}|${exp.ringSpacing}|${exp.offsetScale}|${exp.waveFlatten}`;
    if (sig === cacheSig && chain) return;

    cacheSig = sig;
    const slots: GlyphSlot[] = lays;
    const raster = rasterizeGlyphMask(w, h, cell, slots, s.fontCss, s.fontSize, s.opentypeFont);

    chain = buildContourChain(
      raster.mask,
      raster.cw,
      raster.ch,
      cell,
      count,
      shapeParams(s, cell),
      segBuf,
    );
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
    rebuildChain(s);
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
    if (!chain || lays.length === 0) return;

    const alpha = effectOpacity(s.visual);
    const lw = Math.max(0.35, s.visual.expansion.strokeWidth);
    const col = strokeColor(s);
    const bg = maskFillColor(s.visual.stageBackground);
    const count = chain.masks.length;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    // Shape0 → Shape1 → … : только цепочка, без копий оригинала
    for (let idx = 0; idx < count; idx++) {
      drawFilledContourLayer(
        ctx,
        chain.loops[idx]!,
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
      readViewport();
      rebuild();
      rebuildChain(getSnap());
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
