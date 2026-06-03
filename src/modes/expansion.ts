import gsap from 'gsap';
import type opentype from 'opentype.js';
import { colorForGlyph } from '../utils/colors';
import { clearNeutral } from '../utils/canvas';
import { rasterizeGlyphMask, type GlyphSlot } from '../utils/contourField';
import { drawMaskContourLayer, expandMaskStep } from '../utils/iterativeContours';
import { fillGlyphPath, strokeGlyphPath } from '../utils/opentypeCanvas';
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
  let maskSig = '';
  let tickerFn: (() => void) | null = null;
  let t0 = 0;

  let glyphMask: Uint8Array | null = null;
  let cw = 0;
  let ch = 0;
  let cell = 2;

  let advanceMask: Uint8Array | null = null;
  let advanceRing = 0;

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

  function rebuildMask(s: ModeSnapshot) {
    const { w, h } = readViewport();
    if (w < 32 || h < 32 || lays.length === 0) {
      glyphMask = null;
      advanceMask = null;
      return;
    }

    const exp = s.visual.expansion;
    cell = Math.max(1.25, Math.min(2.75, exp.ringSpacing * 0.38));
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${w}|${h}|${cell}`;
    if (sig === maskSig && glyphMask) return;

    maskSig = sig;
    const slots: GlyphSlot[] = lays;
    const raster = rasterizeGlyphMask(w, h, cell, slots, s.fontCss, s.fontSize, s.opentypeFont);
    glyphMask = raster.mask;
    cw = raster.cw;
    ch = raster.ch;
    advanceMask = new Uint8Array(glyphMask);
    advanceRing = 0;
  }

  function ensure() {
    const s = getSnap();
    const { w, h } = readViewport();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${w}|${h}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      maskSig = '';
      rebuild();
    }
    rebuildMask(s);
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

  function stepParams(s: ModeSnapshot) {
    const exp = s.visual.expansion;
    const spacing = Math.max(3, exp.ringSpacing);
    const radiusCells = Math.max(1, spacing / cell) * (0.65 + exp.offsetScale * 0.45);
    const smoothPasses = Math.round(1 + exp.waveFlatten * 3);
    const threshold = 0.42 - exp.waveFlatten * 0.12;
    return { spacing, radiusCells, smoothPasses, threshold };
  }

  function advanceToRing(target: number, s: ModeSnapshot) {
    if (!glyphMask || !advanceMask) return;
    const { radiusCells, smoothPasses, threshold } = stepParams(s);

    if (target < advanceRing) {
      advanceMask = new Uint8Array(glyphMask);
      advanceRing = 0;
    }

    while (advanceRing < target) {
      advanceMask = expandMaskStep(advanceMask, cw, ch, radiusCells, smoothPasses, threshold);
      advanceRing++;
    }
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
    const s = getSnap();
    const { w, h } = readViewport();
    if (w < 32 || h < 32) return;

    ensure();
    clearNeutral(ctx, w, h, s.visual.stageBackground);
    if (!glyphMask || !advanceMask || lays.length === 0) return;

    const exp = s.visual.expansion;
    const alpha = effectOpacity(s.visual);
    const lw = Math.max(0.35, exp.strokeWidth);
    const col = strokeColor(s);
    const fill = maskFillColor(s.visual.stageBackground);
    const { spacing, radiusCells, smoothPasses, threshold } = stepParams(s);

    const t = s.visual.animationEnabled && !s.visual.sceneFrozen ? (performance.now() - t0) * 0.001 : 0;
    const ringPhase = t * (22 + exp.growSpeed * 10);
    const baseRing = Math.floor(ringPhase);

    const visibleRings = Math.min(72, Math.ceil(Math.max(w, h) / spacing) + 10);

    advanceToRing(baseRing, s);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    let m = advanceMask;

    for (let vi = 0; vi < visibleRings; vi++) {
      if (baseRing === 0 && vi === 0 && s.opentypeFont) {
        drawLetterVector(s, col, lw, alpha, s.opentypeFont, fill);
      } else {
        drawMaskContourLayer(ctx, m, cw, ch, cell, fill, col, lw, alpha, segBuf);
      }

      m = expandMaskStep(m, cw, ch, radiusCells, smoothPasses, threshold);
    }

    ctx.restore();
  }

  return {
    start() {
      layoutSig = '';
      maskSig = '';
      glyphMask = null;
      advanceMask = null;
      advanceRing = 0;
      t0 = performance.now();
      readViewport();
      rebuild();
      rebuildMask(getSnap());
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
