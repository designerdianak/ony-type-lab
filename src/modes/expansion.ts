import gsap from 'gsap';
import type opentype from 'opentype.js';
import { colorForGlyph } from '../utils/colors';
import { clearNeutral } from '../utils/canvas';
import { fillGlyphPath, strokeGlyphPath } from '../utils/opentypeCanvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

type Lay = { char: string; x: number; y: number; w: number; h: number; bl: number };

function fontCssWithSize(fontCss: string, size: number): string {
  if (/\d+px/.test(fontCss)) return fontCss.replace(/\d+px/, `${size}px`);
  return `${fontCss} ${size}px`;
}

function maskFillColor(stageBackground: string): string | null {
  if (stageBackground === 'transparent') return null;
  return stageBackground;
}

function strokeHorizontalBand(
  ctx: CanvasRenderingContext2D,
  y: number,
  w: number,
  stroke: string,
  lineWidth: number,
  alpha: number,
  dist: number,
  fs: number,
) {
  const amp = fs * 0.06 * Math.min(1, dist / (fs * 3));
  const freq = 0.012;
  ctx.beginPath();
  const step = Math.max(3, w / 120);
  for (let x = 0; x <= w + step; x += step) {
    const wy = y + Math.sin(x * freq + dist * 0.08) * amp;
    if (x === 0) ctx.moveTo(x, wy);
    else ctx.lineTo(x, wy);
  }
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.stroke();
}

export function createExpansionMode(
  _canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let lays: Lay[] = [];
  let layoutSig = '';
  let tickerFn: (() => void) | null = null;
  let t0 = 0;
  let bounds = { top: 0, bottom: 0 };

  function rebuild() {
    const s = getSnap();
    const tw = measureLineWidth(ctx, s.text, s.fontCss, s.letterSpacing);
    const ox = (s.w - tw) * 0.5;
    const oy = s.h * 0.55;
    const g = layoutGlyphs(ctx, s.text, s.fontCss, s.fontSize, s.letterSpacing, ox, oy);
    lays = g.map((lg) => ({
      char: lg.char,
      x: lg.x,
      y: lg.y,
      w: lg.w,
      h: lg.h,
      bl: lg.baseline,
    }));
    if (lays.length > 0) {
      bounds = {
        top: Math.min(...lays.map((lg) => lg.bl - lg.h)),
        bottom: Math.max(...lays.map((lg) => lg.bl + lg.h * 0.12)),
      };
    }
  }

  function ensure() {
    const s = getSnap();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.w}|${s.h}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      rebuild();
    }
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

  /** Контурные копии — только снаружи, без кольца на самой букве. */
  function drawRippleRings(
    s: ModeSnapshot,
    col: string,
    lw: number,
    alpha: number,
    font: opentype.Font | null,
    scroll: number,
    ringCount: number,
    spacing: number,
    maxR: number,
    flattenStart: number,
  ) {
    const fs = s.fontSize;
    const exp = s.visual.expansion;
    const minDist = spacing * 1.05;

    for (let ri = ringCount; ri >= 1; ri--) {
      const dist = ri * spacing + (scroll % spacing);
      if (dist < minDist || dist > maxR) continue;

      const edgeFade = dist > maxR * 0.82 ? 1 - (dist - maxR * 0.82) / (maxR * 0.18) : 1;
      const ringAlpha = alpha * Math.max(0.2, edgeFade);
      const ringSize = fs + dist * (1.12 + exp.offsetScale * 0.32);

      ctx.save();
      ctx.globalAlpha = ringAlpha;
      ctx.globalCompositeOperation = 'source-over';

      if (font) {
        for (const g of lays) {
          const path = font.getPath(g.char, g.x, g.bl, ringSize);
          strokeGlyphPath(ctx, path, col, lw);
        }
      } else {
        ctx.font = fontCssWithSize(s.fontCss, ringSize);
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.strokeStyle = col;
        ctx.lineWidth = lw;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        for (const g of lays) ctx.strokeText(g.char, g.x, g.bl);
      }
      ctx.restore();

      if (dist > flattenStart) {
        const extra = dist - flattenStart;
        const yBelow = bounds.bottom + extra * 0.92;
        const yAbove = bounds.top - extra * 0.92;
        if (yBelow < s.h + fs) {
          strokeHorizontalBand(ctx, yBelow, s.w, col, lw, ringAlpha * 0.95, dist, fs);
        }
        if (yAbove > -fs) {
          strokeHorizontalBand(ctx, yAbove, s.w, col, lw, ringAlpha * 0.95, dist, fs);
        }
      }
    }
  }

  /**
   * Верхний слой: заливка цветом фона (перекрывает линии внутри буквы) + контур.
   * Как в референсе 36DaysOfType: читаемая буква, волны только снаружи.
   */
  function drawForegroundLetter(
    s: ModeSnapshot,
    col: string,
    lw: number,
    alpha: number,
    font: opentype.Font | null,
    maskFill: string | null,
  ) {
    const fs = s.fontSize;
    const maskSize = fs + Math.max(4, lw * 3.2);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = alpha;

    if (font) {
      for (const g of lays) {
        const maskPath = font.getPath(g.char, g.x, g.bl, maskSize);
        const letterPath = font.getPath(g.char, g.x, g.bl, fs);

        if (maskFill) {
          fillGlyphPath(ctx, maskPath, maskFill);
          fillGlyphPath(ctx, maskPath, maskFill);
        } else {
          ctx.globalCompositeOperation = 'destination-out';
          fillGlyphPath(ctx, maskPath, 'rgba(0,0,0,1)');
          ctx.globalCompositeOperation = 'source-over';
        }

        strokeGlyphPath(ctx, letterPath, col, lw);
      }
    } else {
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      for (const g of lays) {
        ctx.font = fontCssWithSize(s.fontCss, maskSize);
        if (maskFill) {
          ctx.fillStyle = maskFill;
          ctx.fillText(g.char, g.x, g.bl);
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

    const exp = s.visual.expansion;
    const alpha = effectOpacity(s.visual);
    const fs = s.fontSize;
    const spacing = Math.max(1.5, exp.ringSpacing);
    const lw = Math.max(0.35, exp.strokeWidth);
    const maxR = Math.max(s.w, s.h) * 0.95;
    const ringCount = Math.ceil(maxR / spacing);
    const speed = (0.35 + exp.growSpeed * 1.4) * spacing;
    const t = s.visual.animationEnabled && !s.visual.sceneFrozen ? (performance.now() - t0) * 0.001 : 0;
    const scroll = t * speed;
    const font = s.opentypeFont;
    const col = strokeColor(s, 0);
    const flattenStart = fs * (0.85 + exp.waveFlatten * 1.4);
    const maskFill = maskFillColor(s.visual.stageBackground);

    if (lays.length === 0) return;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    drawRippleRings(s, col, lw, alpha, font, scroll, ringCount, spacing, maxR, flattenStart);
    drawForegroundLetter(s, col, lw, alpha, font, maskFill);
    ctx.restore();
  }

  return {
    start() {
      layoutSig = '';
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
