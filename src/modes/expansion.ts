import gsap from 'gsap';
import type opentype from 'opentype.js';
import { colorForGlyph } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { strokeGlyphPath } from '../utils/opentypeCanvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

type Lay = { char: string; x: number; y: number; w: number; h: number; bl: number };

function fontCssWithSize(fontCss: string, size: number): string {
  if (/\d+px/.test(fontCss)) return fontCss.replace(/\d+px/, `${size}px`);
  return `${fontCss} ${size}px`;
}

/** Горизонтальная «полоса» контура — как в референсе у нижнего/верхнего края. */
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
  let bounds = { top: 0, bottom: 0, cx: 0 };

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
      const tops = lays.map((lg) => lg.bl - lg.h);
      const bots = lays.map((lg) => lg.bl + lg.h * 0.12);
      bounds = {
        top: Math.min(...tops),
        bottom: Math.max(...bots),
        cx: ox + tw * 0.5,
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

  function drawRingGlyphs(
    s: ModeSnapshot,
    dist: number,
    col: string,
    lw: number,
    alpha: number,
    font: opentype.Font | null,
  ) {
    const fs = s.fontSize;
    const ringSize = fs + dist * (1.15 + s.visual.expansion.offsetScale * 0.35);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (font) {
      for (let gi = 0; gi < lays.length; gi++) {
        const g = lays[gi]!;
        const path = font.getPath(g.char, g.x, g.bl, ringSize);
        strokeGlyphPath(ctx, path, col, lw);
      }
    } else {
      ctx.font = fontCssWithSize(s.fontCss, ringSize);
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.strokeStyle = col;
      ctx.lineWidth = lw;
      for (const g of lays) {
        ctx.strokeText(g.char, g.x, g.bl);
      }
    }
    ctx.restore();
  }

  function tick() {
    const s = getSnap();
    ensure();
    clearNeutral(ctx, s.w, s.h, s.visual.stageBackground);
    applyMultiplyBlend(ctx, s.visual.multiplyBlend);

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

    for (let ri = ringCount; ri >= 0; ri--) {
      const dist = ri * spacing + (scroll % spacing);
      if (dist > maxR) continue;

      const edgeFade = dist > maxR * 0.82 ? 1 - (dist - maxR * 0.82) / (maxR * 0.18) : 1;
      const ringAlpha = alpha * Math.max(0.15, edgeFade);

      drawRingGlyphs(s, dist, col, lw, ringAlpha, font);

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

    if (lays.length > 0) {
      drawRingGlyphs(s, 0, col, lw, alpha, font);
    }
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
