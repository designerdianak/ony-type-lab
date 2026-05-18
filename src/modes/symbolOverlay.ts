import gsap from 'gsap';
import { colorForGlyph } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import type { ModeController, ModeSnapshot } from './types';

const SYMBOL_POOL =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789?!@#%&*+-=:/<>[]{}§$';

type G = {
  char: string;
  x: number;
  bl: number;
  w: number;
  h: number;
  /** 0 = только базовая буква, 1 = оверлей включён */
  active: number;
  sym: string;
};

export function createSymbolOverlayMode(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let glyphs: G[] = [];
  let layoutSig = '';
  let tickerFn: (() => void) | null = null;
  let pointerHandler: ((e: PointerEvent) => void) | null = null;
  let frame = 0;
  let lastCanvasClearNonce = 0;

  function pickSym(baseChar: string) {
    let s = SYMBOL_POOL[Math.floor(Math.random() * SYMBOL_POOL.length)]!;
    if (Math.random() < 0.35) {
      for (let t = 0; t < 4 && s === baseChar; t++) {
        s = SYMBOL_POOL[Math.floor(Math.random() * SYMBOL_POOL.length)]!;
      }
    }
    return s;
  }

  function rebuild() {
    const s = getSnap();
    const tw = measureLineWidth(ctx, s.text, s.fontCss, s.letterSpacing);
    const ox = (s.w - tw) * 0.5;
    const oy = s.h * 0.55;
    const lays = layoutGlyphs(ctx, s.text, s.fontCss, s.fontSize, s.letterSpacing, ox, oy);
    const allOn = s.visual.symbol.interaction === 'alwaysOn';
    glyphs = lays.map((g) => ({
      char: g.char,
      x: g.x,
      bl: g.baseline,
      w: g.w,
      h: g.h,
      active: allOn ? 1 : 0,
      sym: pickSym(g.char),
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
    for (let i = glyphs.length - 1; i >= 0; i--) {
      const g = glyphs[i]!;
      const pad = 4;
      if (px >= g.x - pad && px <= g.x + g.w + pad && py >= g.bl - g.h - pad && py <= g.bl + pad) return i;
    }
    return -1;
  }

  function toggleSlot(idx: number) {
    const g = glyphs[idx]!;
    if (g.active > 0.5) {
      g.active = 0;
    } else {
      g.active = 1;
      g.sym = pickSym(g.char);
    }
  }

  function tick() {
    const s = getSnap();
    const cn = s.visual.canvasClearNonce ?? 0;
    if (cn !== lastCanvasClearNonce) {
      lastCanvasClearNonce = cn;
      layoutSig = '';
      frame = 0;
    }
    ensure();

    clearNeutral(ctx, s.w, s.h, s.visual.stageBackground);

    const always = s.visual.symbol.interaction === 'alwaysOn';
    const frozen = s.visual.sceneFrozen;
    const overlayAlpha = 0.45 + s.visual.symbol.symbolDensity * 0.5;

    if (!frozen) {
      frame += 1;
      const every = Math.max(4, Math.round(s.visual.symbol.swapEveryFrames));
      if (frame % every === 0) {
        for (const g of glyphs) {
          if (always || g.active > 0.5) g.sym = pickSym(g.char);
        }
      }
    }

    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i]!;
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle =
        s.visual.colorMode === 'monochrome'
          ? s.visual.monochromeColor
          : colorForGlyph({
              mode: s.visual.colorMode,
              monochrome: s.visual.monochromeColor,
              seed: s.visual.rainbowSeed,
              index: i,
              total: glyphs.length,
            });
      ctx.fillText(g.char, g.x, g.bl);
    }
    ctx.restore();

    const useMultiply = s.visual.multiplyBlend;
    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.globalCompositeOperation = useMultiply ? 'multiply' : 'source-over';

    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i]!;
      const on = always || g.active > 0.5;
      if (!on) continue;

      ctx.globalAlpha = overlayAlpha;
      ctx.fillStyle = colorForGlyph({
        mode: 'rainbow',
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed + 7,
        index: i + 2,
        total: glyphs.length + 4,
      });
      ctx.fillText(g.sym, g.x, g.bl);
    }
    ctx.restore();

    applyMultiplyBlend(ctx, false);
  }

  return {
    start() {
      layoutSig = '';
      frame = 0;
      lastCanvasClearNonce = getSnap().visual.canvasClearNonce ?? 0;
      tickerFn = () => tick();
      gsap.ticker.add(tickerFn);

      pointerHandler = (ev: PointerEvent) => {
        const snap = getSnap();
        if (snap.visual.sceneFrozen) return;
        if (snap.visual.symbol.interaction === 'alwaysOn') return;
        const r = canvas.getBoundingClientRect();
        const idx = hit(ev.clientX - r.left, ev.clientY - r.top);
        if (idx >= 0) toggleSlot(idx);
      };

      canvas.addEventListener('pointerdown', pointerHandler);
    },
    stop() {
      if (tickerFn) gsap.ticker.remove(tickerFn);
      tickerFn = null;
      if (pointerHandler) canvas.removeEventListener('pointerdown', pointerHandler);
      pointerHandler = null;
    },
    dispose() {
      this.stop();
    },
    interruptInteraction() {},
  };
}
