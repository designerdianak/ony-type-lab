import gsap from 'gsap';
import type opentype from 'opentype.js';
import { colorForGlyph } from '../utils/colors';
import { clearNeutral } from '../utils/canvas';
import {
  buildGlyphSdf,
  drawSdfWarpedHorizontals,
  extractSdfIsoline,
  sdfMaxDistance,
  type SdfGrid,
} from '../utils/glyphSdf';
import { drawContourSegments } from '../utils/contourField';
import { fillGlyphPath, strokeGlyphPath } from '../utils/opentypeCanvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';
import type { GlyphSlot } from '../utils/contourField';

type Lay = { char: string; x: number; bl: number };

function fontCssWithSize(fontCss: string, size: number): string {
  if (/\d+px/.test(fontCss)) return fontCss.replace(/\d+px/, `${size}px`);
  return `${fontCss} ${size}px`;
}

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
  let sdfSig = '';
  let tickerFn: (() => void) | null = null;
  let t0 = 0;
  let sdfGrid: SdfGrid | null = null;
  let maxDist = 0;

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

  function rebuildSdf(s: ModeSnapshot) {
    const { w, h } = readViewport();
    if (w < 32 || h < 32 || lays.length === 0) {
      sdfGrid = null;
      return;
    }

    const exp = s.visual.expansion;
    const detail = exp.waveFlatten;
    const cell = Math.max(1.25, Math.min(2.5, exp.ringSpacing * (0.28 - detail * 0.08)));
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${w}|${h}|${cell}`;
    if (sig === sdfSig && sdfGrid) return;

    sdfSig = sig;
    const slots: GlyphSlot[] = lays;
    sdfGrid = buildGlyphSdf(w, h, cell, slots, s.fontCss, s.fontSize, s.opentypeFont);
    maxDist = sdfMaxDistance(sdfGrid.sdf);
  }

  function ensure() {
    const s = getSnap();
    const { w, h } = readViewport();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${w}|${h}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      sdfSig = '';
      rebuild();
    }
    rebuildSdf(s);
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

  function drawForegroundLetter(
    s: ModeSnapshot,
    col: string,
    lw: number,
    alpha: number,
    font: opentype.Font | null,
    maskFill: string | null,
  ) {
    const fs = s.fontSize;
    const pad = Math.max(3, lw * 2.5);

    ctx.save();
    ctx.globalAlpha = alpha;

    if (font) {
      for (const g of lays) {
        const letter = font.getPath(g.char, g.x, g.bl, fs);
        const mask = font.getPath(g.char, g.x, g.bl, fs + pad);
        if (maskFill) fillGlyphPath(ctx, mask, maskFill);
        else {
          ctx.globalCompositeOperation = 'destination-out';
          fillGlyphPath(ctx, mask, 'rgba(0,0,0,1)');
          ctx.globalCompositeOperation = 'source-over';
        }
        strokeGlyphPath(ctx, letter, col, lw);
      }
    } else {
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      for (const g of lays) {
        ctx.font = fontCssWithSize(s.fontCss, fs + pad);
        if (maskFill) {
          ctx.fillStyle = maskFill;
          ctx.fillText(g.char, g.x, g.bl);
        } else {
          ctx.globalCompositeOperation = 'destination-out';
          ctx.fillStyle = 'rgba(0,0,0,1)';
          ctx.fillText(g.char, g.x, g.bl);
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.font = s.fontCss;
        ctx.strokeStyle = col;
        ctx.lineWidth = lw;
        ctx.strokeText(g.char, g.x, g.bl);
      }
    }
    ctx.restore();
  }

  function tick() {
    const s = getSnap();
    const { w, h } = readViewport();
    if (w < 32 || h < 32) return;

    ensure();
    clearNeutral(ctx, w, h, s.visual.stageBackground);
    if (!sdfGrid || lays.length === 0) return;

    const exp = s.visual.expansion;
    const alpha = effectOpacity(s.visual);
    const spacing = Math.max(4, exp.ringSpacing);
    const lw = Math.max(0.35, exp.strokeWidth);
    const col = strokeColor(s);
    const maskFill = maskFillColor(s.visual.stageBackground);

    const t = s.visual.animationEnabled && !s.visual.sceneFrozen ? (performance.now() - t0) * 0.001 : 0;
    const phase = t * (6 + exp.growSpeed * 28);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    const influenceRadius = Math.max(spacing * 4, s.fontSize * (2 + exp.offsetScale * 2));
    const strength = s.fontSize * (0.42 + exp.offsetScale * 0.5);

    drawSdfWarpedHorizontals(
      ctx,
      sdfGrid,
      w,
      h,
      spacing,
      influenceRadius,
      strength,
      col,
      lw,
      alpha,
      phase,
    );

    const maxLevel = Math.min(maxDist, Math.max(w, h) * 0.98);
    const levelCount = Math.ceil(maxLevel / spacing) + 2;

    for (let li = levelCount; li >= 1; li--) {
      const level = li * spacing + (phase % spacing);
      if (level < 1 || level > maxLevel) continue;

      const fade =
        level > maxLevel * 0.85 ? 1 - (level - maxLevel * 0.85) / (maxLevel * 0.15 + 1) : 1;

      segBuf.length = 0;
      extractSdfIsoline(sdfGrid, level, segBuf);
      if (segBuf.length > 0) {
        drawContourSegments(ctx, segBuf, col, lw, alpha * Math.max(0.35, fade));
      }
    }

    drawForegroundLetter(s, col, lw, alpha, s.opentypeFont, maskFill);
    ctx.restore();
  }

  return {
    start() {
      layoutSig = '';
      sdfSig = '';
      sdfGrid = null;
      t0 = performance.now();
      readViewport();
      rebuild();
      rebuildSdf(getSnap());
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
