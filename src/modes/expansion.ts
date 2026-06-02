import gsap from 'gsap';
import { colorForGlyph } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

type Lay = { char: string; x: number; y: number; w: number; h: number; bl: number };

export function createExpansionMode(
  _canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let lays: Lay[] = [];
  let layoutSig = '';
  let tickerFn: (() => void) | null = null;
  let t0 = 0;

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

  function tick() {
    const s = getSnap();
    ensure();
    clearNeutral(ctx, s.w, s.h, s.visual.stageBackground);
    applyMultiplyBlend(ctx, s.visual.multiplyBlend);

    const exp = s.visual.expansion;
    const alpha = effectOpacity(s.visual);
    const fs = s.fontSize;
    const spacing = Math.max(1, exp.ringSpacing);
    const maxR = Math.hypot(s.w, s.h) * 0.72;
    const ringCount = Math.ceil(maxR / spacing) + 2;
    const speed = 0.08 + exp.growSpeed * 0.55;
    const t = s.visual.animationEnabled && !s.visual.sceneFrozen ? (performance.now() - t0) * 0.001 : 0;

    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (let gi = 0; gi < lays.length; gi++) {
      const g = lays[gi]!;
      const cx = g.x + g.w * 0.5;
      const cy = g.bl - g.h * 0.5;
      const col = strokeColor(s, gi);

      for (let ri = 0; ri < ringCount; ri++) {
        const base = ri / ringCount;
        const phase = (base + t * speed) % 1;
        const scale = 1 + phase * (maxR / Math.max(fs, 1));
        const ringAlpha = (1 - phase) * (1 - phase) * alpha;
        if (ringAlpha < 0.02) continue;

        ctx.save();
        ctx.globalAlpha = ringAlpha;
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(0.25, exp.strokeWidth / scale);
        ctx.translate(cx, cy);
        ctx.scale(scale, scale);
        ctx.translate(-cx, -cy);
        ctx.strokeText(g.char, g.x, g.bl);
        ctx.restore();
      }

      ctx.globalAlpha = alpha;
      ctx.strokeStyle = col;
      ctx.lineWidth = exp.strokeWidth;
      ctx.strokeText(g.char, g.x, g.bl);
    }
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
