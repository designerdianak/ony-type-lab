import gsap from 'gsap';
import { colorForGlyph, lerpColor } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

export function createColorStackMode(
  _canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let layoutSig = '';
  let tickerFn: (() => void) | null = null;

  function tick() {
    const s = getSnap();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.w}|${s.h}`;
    if (sig !== layoutSig) layoutSig = sig;

    clearNeutral(ctx, s.w, s.h, s.visual.stageBackground);
    applyMultiplyBlend(ctx, s.visual.multiplyBlend);

    const cs = s.visual.colorStack;
    const alpha = effectOpacity(s.visual);
    const tw = measureLineWidth(ctx, s.text, s.fontCss, s.letterSpacing);
    const ox = (s.w - tw) * 0.5;
    const oy = s.h * 0.55;
    const lays = layoutGlyphs(ctx, s.text, s.fontCss, s.fontSize, s.letterSpacing, ox, oy);
    const count = Math.max(1, Math.round(cs.duplicateCount));
    const rad = (cs.angleDeg * Math.PI) / 180;
    const dx = Math.cos(rad) * cs.offsetX * s.fontSize * 0.08;
    const dy = Math.sin(rad) * cs.offsetY * s.fontSize * 0.08;

    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    for (const g of lays) {
      for (let i = count; i >= 1; i--) {
        const t = i / count;
        const fill = cs.useRainbowStack
          ? colorForGlyph({
              mode: 'rainbow',
              monochrome: s.visual.monochromeColor,
              seed: s.visual.rainbowSeed + i * 0.17,
              index: g.char.charCodeAt(0) + i,
              total: count + 4,
            })
          : lerpColor(cs.stackColor, s.visual.monochromeColor, 1 - t * 0.15);

        ctx.globalAlpha = alpha;
        ctx.fillStyle = fill;
        ctx.fillText(g.char, g.x + dx * i, g.baseline + dy * i);
      }

      const top = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: g.char.charCodeAt(0),
        total: lays.length,
      });
      ctx.globalAlpha = alpha;
      ctx.fillStyle = top;
      ctx.fillText(g.char, g.x, g.baseline);
    }
    ctx.restore();
  }

  return {
    start() {
      layoutSig = '';
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
