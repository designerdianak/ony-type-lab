import gsap from 'gsap';
import { colorForGlyph, gradientAt, mulberry32, randomVividPalette } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutTextForCanvas } from '../utils/textLayout';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

export function createGradientFlowMode(
  _canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let layoutSig = '';
  let tickerFn: (() => void) | null = null;

  function palette(s: ModeSnapshot): string[] {
    const e = s.visual.elastic;
    if (e.randomGradient) {
      const rng = mulberry32(Math.floor(s.visual.rainbowSeed * 1000));
      return randomVividPalette(rng() * 1000, 5);
    }
    return [e.colorA, e.colorB, e.colorC];
  }

  function tick() {
    const s = getSnap();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.lineHeight}|${s.w}|${s.h}`;
    if (sig !== layoutSig) layoutSig = sig;

    clearNeutral(ctx, s.w, s.h, s.visual.stageBackground);
    applyMultiplyBlend(ctx, s.visual.multiplyBlend);

    const e = s.visual.elastic;
    const alpha = effectOpacity(s.visual);
    const block = layoutTextForCanvas(
      ctx,
      s.text,
      s.fontCss,
      s.fontSize,
      s.letterSpacing,
      s.w,
      s.h,
      s.lineHeight,
    );
    const lays = block.glyphs;
    const fs = block.effectiveFontSize;
    const fontCss = block.effectiveFontCss;
    const steps = Math.max(4, Math.round(e.flowLength));
    const rad = (e.directionDeg * Math.PI) / 180;
    const dx = Math.cos(rad) * e.stepSize * fs * 0.06;
    const dy = Math.sin(rad) * e.stepSize * fs * 0.06;
    const pal = palette(s);

    ctx.save();
    ctx.font = fontCss;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    for (const g of lays) {
      for (let i = steps; i >= 1; i--) {
        const t = i / steps;
        ctx.globalAlpha = alpha * (0.35 + 0.65 * t);
        ctx.fillStyle =
          s.visual.colorMode === 'rainbow' && !e.randomGradient
            ? colorForGlyph({
                mode: 'rainbow',
                monochrome: s.visual.monochromeColor,
                seed: s.visual.rainbowSeed,
                index: i,
                total: steps,
              })
            : gradientAt(pal, 1 - t);
        ctx.fillText(g.char, g.x + dx * i, g.baseline + dy * i);
      }

      ctx.globalAlpha = alpha;
      ctx.fillStyle = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: g.char.charCodeAt(0),
        total: lays.length,
      });
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
