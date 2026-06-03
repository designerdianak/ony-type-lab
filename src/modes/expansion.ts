import gsap from 'gsap';
import type opentype from 'opentype.js';
import { colorForGlyph } from '../utils/colors';
import { clearNeutral } from '../utils/canvas';
import {
  chamferDistance,
  drawContourSegments,
  extractIsoContour,
  rasterizeGlyphMask,
  type GlyphSlot,
} from '../utils/contourField';
import { fillGlyphPath, strokeGlyphPath } from '../utils/opentypeCanvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

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
  _canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let lays: Lay[] = [];
  let layoutSig = '';
  let fieldSig = '';
  let tickerFn: (() => void) | null = null;
  let t0 = 0;

  let distField: Float32Array | null = null;
  let gridCw = 0;
  let gridCh = 0;
  let gridCell = 2;
  let maxDistCells = 0;

  const segBuf: { x0: number; y0: number; x1: number; y1: number }[] = [];

  function rebuild() {
    const s = getSnap();
    const tw = measureLineWidth(ctx, s.text, s.fontCss, s.letterSpacing);
    const ox = (s.w - tw) * 0.5;
    const oy = s.h * 0.55;
    const g = layoutGlyphs(ctx, s.text, s.fontCss, s.fontSize, s.letterSpacing, ox, oy);
    lays = g.map((lg) => ({ char: lg.char, x: lg.x, bl: lg.baseline }));
  }

  function ensureField(s: ModeSnapshot) {
    const exp = s.visual.expansion;
    const detail = exp.waveFlatten;
    gridCell = Math.max(1.25, Math.min(3.5, exp.ringSpacing * (0.35 - detail * 0.12)));
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.w}|${s.h}|${gridCell}`;
    if (sig === fieldSig && distField) return;

    fieldSig = sig;
    const slots: GlyphSlot[] = lays;
    const { mask, cw, ch } = rasterizeGlyphMask(
      s.w,
      s.h,
      gridCell,
      slots,
      s.fontCss,
      s.fontSize,
      s.opentypeFont,
    );
    gridCw = cw;
    gridCh = ch;
    distField = chamferDistance(mask, cw, ch);

    let mx = 0;
    for (let i = 0; i < distField.length; i++) {
      if (distField[i]! < 1e6 && distField[i]! > mx) mx = distField[i]!;
    }
    maxDistCells = mx;
  }

  function ensure() {
    const s = getSnap();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.w}|${s.h}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      fieldSig = '';
      rebuild();
    }
    ensureField(s);
  }

  function strokeColor(s: ModeSnapshot, index: number) {
    const exp = s.visual.expansion;
    if (exp.strokeColor !== 'auto' && exp.strokeColor) return exp.strokeColor;
    return colorForGlyph({
      mode: s.visual.colorMode,
      monochrome: s.visual.monochromeColor,
      seed: s.visual.rainbowSeed,
      index,
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
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = alpha;

    if (font) {
      for (const g of lays) {
        const letter = font.getPath(g.char, g.x, g.bl, fs);
        const mask = font.getPath(g.char, g.x, g.bl, fs + pad);
        if (maskFill) {
          fillGlyphPath(ctx, mask, maskFill);
        } else {
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
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeText(g.char, g.x, g.bl);
      }
    }
    ctx.restore();
  }

  function tick() {
    const s = getSnap();
    ensure();
    clearNeutral(ctx, s.w, s.h, s.visual.stageBackground);

    if (!distField || lays.length === 0) return;

    const exp = s.visual.expansion;
    const alpha = effectOpacity(s.visual);
    const spacingCells = Math.max(1.2, exp.ringSpacing / gridCell) * (0.85 + exp.offsetScale * 0.2);
    const lw = Math.max(0.35, exp.strokeWidth);
    const col = strokeColor(s, 0);
    const maskFill = maskFillColor(s.visual.stageBackground);

    const maxR = maxDistCells + 4;
    const ringCount = Math.ceil(maxR / spacingCells) + 2;
    const speed = (0.25 + exp.growSpeed * 0.9) * spacingCells;
    const t = s.visual.animationEnabled && !s.visual.sceneFrozen ? (performance.now() - t0) * 0.001 : 0;
    const scroll = t * speed;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    for (let ri = ringCount; ri >= 1; ri--) {
      const iso = ri * spacingCells + (scroll % spacingCells);
      if (iso < spacingCells * 0.85 || iso > maxR) continue;

      const fade =
        iso > maxR * 0.88 ? 1 - (iso - maxR * 0.88) / (maxR * 0.12 + 0.01) : 1;
      const ringAlpha = alpha * Math.max(0.25, fade);

      segBuf.length = 0;
      extractIsoContour(distField, gridCw, gridCh, iso, gridCell, segBuf);
      drawContourSegments(ctx, segBuf, col, lw, ringAlpha);
    }

    drawForegroundLetter(s, col, lw, alpha, s.opentypeFont, maskFill);
    ctx.restore();
  }

  return {
    start() {
      layoutSig = '';
      fieldSig = '';
      distField = null;
      t0 = performance.now();
      rebuild();
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
