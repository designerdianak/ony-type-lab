import gsap from 'gsap';
import { colorForGlyph, lerp } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import type { ModeController, ModeSnapshot } from './types';

type G = {
  char: string;
  x: number;
  y: number;
  tx: number;
  ty: number;
  jx: number;
  jy: number;
  w: number;
  h: number;
};

export function createAssemblyMode(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let glyphs: G[] = [];
  let layoutSig = '';
  let tickerFn: (() => void) | null = null;
  let enterTl: gsap.core.Timeline | null = null;
  let jumpAcc = 0;

  function rebuild() {
    const s = getSnap();
    const spacingBoost = s.visual.assembly.overlap ? 0 : s.fontSize * 0.08;
    const letter = s.letterSpacing + spacingBoost;
    const tw = measureLineWidth(ctx, s.text, s.fontCss, letter);
    const baseOx = (s.w - tw) * 0.5;
    const oy = s.h * 0.55;
    const lays = layoutGlyphs(ctx, s.text, s.fontCss, s.fontSize, letter, baseOx, oy);
    glyphs = lays.map((g) => ({
      char: g.char,
      x: Math.random() * s.w,
      y: -80 - Math.random() * 120,
      tx: g.x,
      ty: g.baseline,
      jx: 0,
      jy: 0,
      w: g.w,
      h: g.h,
    }));
    enterTl?.kill();
    enterTl = gsap.timeline({ defaults: { ease: 'power3.inOut' } });
    glyphs.forEach((g, i) => {
      enterTl!.to(
        g,
        {
          x: g.tx,
          y: g.ty,
          duration: 1.35,
          delay: i * 0.04,
        },
        0,
      );
    });
  }

  function ensure() {
    const s = getSnap();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.w}|${s.h}|${s.visual.assembly.overlap}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      rebuild();
    }
  }

  function tick() {
    const s = getSnap();
    ensure();
    clearNeutral(ctx, s.w, s.h);
    applyMultiplyBlend(ctx, s.visual.multiplyBlend);

    const grid = Math.max(1, s.visual.assembly.pixelJump);
    jumpAcc += s.animationEnabled ? 1 : 0.25;
    if (jumpAcc > 10) {
      jumpAcc = 0;
      const drift = s.visual.assembly.drift * grid * 4;
      for (const g of glyphs) {
        if (!s.animationEnabled) continue;
        g.jx = Math.round((Math.random() - 0.5) * drift / grid) * grid;
        g.jy = Math.round((Math.random() - 0.5) * drift * 0.6 / grid) * grid;
      }
    }

    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'alphabetic';
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i]!;
      const pull = s.animationEnabled ? 0.18 : 0.32;
      g.jx = lerp(g.jx, 0, pull);
      g.jy = lerp(g.jy, 0, pull);
      const fill = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: i,
        total: glyphs.length,
      });
      ctx.fillStyle = fill;
      ctx.fillText(g.char, g.x + g.jx, g.y + g.jy);
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
      enterTl?.kill();
      enterTl = null;
    },
    dispose() {
      this.stop();
    },
  };
}
