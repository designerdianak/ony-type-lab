import gsap from 'gsap';
import { colorForGlyph } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import type { ModeController, ModeSnapshot } from './types';

/** Символы, которые обычно есть в кастомных шрифтах (без редкого юникода) */
const GLYPH_OVERLAY_POOL = '0123456789?!@#%&*+-=:/<>[]{}';

function fontCssAtSize(fontCss: string, sizePx: number): string {
  return fontCss.replace(/[\d.]+(?=px\b)/, String(Math.round(sizePx)));
}

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
  let moveHandler: ((e: PointerEvent) => void) | null = null;
  let frame = 0;
  let lastCanvasClearNonce = 0;

  function pickSym() {
    return GLYPH_OVERLAY_POOL[Math.floor(Math.random() * GLYPH_OVERLAY_POOL.length)]!;
  }

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
      sym: pickSym(),
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
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i]!;
      const pad = 6;
      if (px >= g.x - pad && px <= g.x + g.w + pad && py >= g.bl - g.h - pad && py <= g.bl + pad) return i;
    }
    return -1;
  }

  function pokeNear(px: number, py: number, r: number) {
    const r2 = r * r;
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i]!;
      const cx = g.x + g.w * 0.5;
      const cy = g.bl - g.h * 0.5;
      if ((px - cx) ** 2 + (py - cy) ** 2 <= r2) g.active = 1;
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
    applyMultiplyBlend(ctx, s.visual.multiplyBlend);
    const t = performance.now();
    const always = s.visual.symbol.interaction === 'alwaysOn';
    const frozen = s.visual.sceneFrozen;

    if (!frozen) {
      frame += 1;
      const every = Math.max(4, Math.round(s.visual.symbol.swapEveryFrames));
      if (frame % every === 0) {
        for (const g of glyphs) {
          if (always || g.active > 0.2) g.sym = pickSym();
        }
      }
    }

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
      ctx.fillStyle = fill;
      ctx.fillText(g.char, g.x, g.bl);
    }
    ctx.restore();

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const symSize = Math.max(14, s.fontSize * 0.32 * s.visual.symbol.symbolDensity);
    ctx.font = fontCssAtSize(s.fontCss, symSize);
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i]!;
      const on = always || g.active > 0.2;
      if (!on) continue;
      if (!frozen) g.rot += 0.0028 * (s.animationEnabled ? 1 : 0.15);
      const cx = g.x + g.w * 0.5;
      const cy = g.bl - g.h * 0.52 + Math.sin(t * 0.00085 + i) * 2.5;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(g.rot);
      ctx.globalAlpha = 0.72;
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
      frame = 0;
      lastCanvasClearNonce = getSnap().visual.canvasClearNonce ?? 0;
      tickerFn = () => tick();
      gsap.ticker.add(tickerFn);
      clickHandler = (ev: MouseEvent) => {
        const s = getSnap();
        if (s.visual.symbol.interaction !== 'clickToPaint') return;
        const r = canvas.getBoundingClientRect();
        const idx = hit(ev.clientX - r.left, ev.clientY - r.top);
        if (idx >= 0) glyphs[idx]!.active = 1;
      };
      moveHandler = (ev: PointerEvent) => {
        const s = getSnap();
        if (s.visual.sceneFrozen) return;
        if (s.visual.symbol.interaction !== 'clickToPaint') return;
        const r = canvas.getBoundingClientRect();
        const px = ev.clientX - r.left;
        const py = ev.clientY - r.top;
        pokeNear(px, py, Math.max(48, s.fontSize * 0.85));
      };
      canvas.addEventListener('click', clickHandler);
      canvas.addEventListener('pointermove', moveHandler);
    },
    stop() {
      if (tickerFn) gsap.ticker.remove(tickerFn);
      tickerFn = null;
      if (clickHandler) canvas.removeEventListener('click', clickHandler);
      if (moveHandler) canvas.removeEventListener('pointermove', moveHandler);
      clickHandler = null;
      moveHandler = null;
    },
    dispose() {
      this.stop();
    },
    interruptInteraction() {},
  };
}
