import gsap from 'gsap';
import { colorForGlyph } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import type { ModeController, ModeSnapshot } from './types';

const SYMBOLS = ['◇', '○', '△', '✦', '⊕', '⊗', '∞', '⌁', '⌘', '◈'];

type G = {
  char: string;
  x: number;
  bl: number;
  w: number;
  h: number;
  active: number;
  sym: string;
  rot: number;
};

export function createSymbolOverlayMode(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let glyphs: G[] = [];
  let layoutSig = '';
  let tickerFn: (() => void) | null = null;
  let clickHandler: ((e: MouseEvent) => void) | null = null;

  function rebuild() {
    const s = getSnap();
    const tw = measureLineWidth(ctx, s.text, s.fontCss, s.letterSpacing);
    const ox = (s.w - tw) * 0.5;
    const oy = s.h * 0.55;
    const lays = layoutGlyphs(ctx, s.text, s.fontCss, s.fontSize, s.letterSpacing, ox, oy);
    glyphs = lays.map((g) => ({
      char: g.char,
      x: g.x,
      bl: g.baseline,
      w: g.w,
      h: g.h,
      active: s.visual.symbol.interaction === 'alwaysOn' ? 1 : 0,
      sym: SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)]!,
      rot: Math.random() * Math.PI,
    }));
  }

  function ensure() {
    const s = getSnap();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.w}|${s.h}|${s.visual.symbol.interaction}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      rebuild();
    }
  }

  function hit(px: number, py: number): number {
    let best = -1;
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i]!;
      if (px >= g.x && px <= g.x + g.w && py >= g.bl - g.h && py <= g.bl + 8) best = i;
    }
    return best;
  }

  function tick() {
    const s = getSnap();
    ensure();
    clearNeutral(ctx, s.w, s.h);
    applyMultiplyBlend(ctx, s.visual.multiplyBlend);
    const t = performance.now();
    const always = s.visual.symbol.interaction === 'alwaysOn';

    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'alphabetic';
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i]!;
      const fill =
        always || g.active > 0.05
          ? colorForGlyph({
              mode: s.visual.colorMode,
              monochrome: s.visual.monochromeColor,
              seed: s.visual.rainbowSeed,
              index: i,
              total: glyphs.length,
            })
          : '#0a0a0a';
      if (!always && g.active > 0 && g.active < 1) g.active = Math.min(1, g.active + 0.08);
      ctx.globalAlpha = 1;
      ctx.fillStyle = fill;
      ctx.fillText(g.char, g.x, g.bl);
    }
    ctx.restore();

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const symSize = Math.max(10, s.fontSize * 0.22 * s.visual.symbol.symbolDensity);
      const famMatch = /"([^"]+)"/.exec(s.fontCss);
      const fam = famMatch?.[1] ?? 'ONYByteLab';
      ctx.font = `${symSize}px "${fam}"`;
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i]!;
      const on = always || g.active > 0.2;
      if (!on) continue;
      g.rot += 0.003 * (s.animationEnabled ? 1 : 0.2);
      if (Math.random() < 0.002 * s.visual.symbol.symbolDensity) {
        g.sym = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)]!;
      }
      const cx = g.x + g.w * 0.5;
      const cy = g.bl - g.h * 0.55 + Math.sin(t * 0.001 + i) * 3;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(g.rot);
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed + 3,
        index: i + 4,
        total: glyphs.length + 4,
      });
      ctx.fillText(g.sym, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  return {
    start() {
      layoutSig = '';
      tickerFn = () => tick();
      gsap.ticker.add(tickerFn);
      clickHandler = (ev: MouseEvent) => {
        const s = getSnap();
        if (s.visual.symbol.interaction !== 'clickToPaint') return;
        const r = canvas.getBoundingClientRect();
        const idx = hit(ev.clientX - r.left, ev.clientY - r.top);
        if (idx >= 0) glyphs[idx]!.active = 1;
      };
      canvas.addEventListener('click', clickHandler);
    },
    stop() {
      if (tickerFn) gsap.ticker.remove(tickerFn);
      tickerFn = null;
      if (clickHandler) canvas.removeEventListener('click', clickHandler);
      clickHandler = null;
    },
    dispose() {
      this.stop();
    },
  };
}
