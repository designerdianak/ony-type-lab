import gsap from 'gsap';
import { colorForGlyph } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import type { ModeController, ModeSnapshot } from './types';

export function createElasticLineMode(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let chars: string[] = [];
  let leftX: number[] = [];
  let widths: number[] = [];
  let baselineY = 0;
  let layoutSig = '';
  let dragIdx = -1;
  let grabOffset = 0;
  let tickerFn: (() => void) | null = null;
  let down: ((e: PointerEvent) => void) | null = null;
  let move: ((e: PointerEvent) => void) | null = null;
  let up: (() => void) | null = null;

  function rebuild() {
    const s = getSnap();
    const tw = measureLineWidth(ctx, s.text, s.fontCss, s.letterSpacing);
    const ox = (s.w - tw) * 0.5;
    const oy = s.h * 0.55;
    const lays = layoutGlyphs(ctx, s.text, s.fontCss, s.fontSize, s.letterSpacing, ox, oy);
    chars = lays.map((g) => g.char);
    widths = lays.map((g) => g.w);
    leftX = lays.map((g) => g.x);
    baselineY = lays[0]?.baseline ?? oy;
    dragIdx = -1;
  }

  function ensure() {
    const s = getSnap();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.w}|${s.h}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      rebuild();
    }
  }

  function hit(px: number): number {
    for (let i = 0; i < leftX.length; i++) {
      const L = leftX[i]!;
      const R = L + widths[i]!;
      if (px >= L && px <= R) return i;
    }
    return -1;
  }

  function gapFills(dr: number): { x: number; a: number; ch: string }[] {
    const s = getSnap();
    if (dr < 0 || dr >= chars.length) return [];
    const ch = chars[dr]!;
    const sp = Math.max(5, (widths[dr] ?? s.fontSize * 0.5) * s.visual.elastic.fillSpacing);
    const out: { x: number; a: number; ch: string }[] = [];
    const run = (edgeA: number, edgeB: number) => {
      const lo = Math.min(edgeA, edgeB);
      const hi = Math.max(edgeA, edgeB);
      let x = lo + sp * 0.45;
      while (x < hi - sp * 0.35) {
        out.push({ x, a: 0.2, ch });
        x += sp;
      }
    };
    if (dr > 0) run(leftX[dr - 1]! + widths[dr - 1]!, leftX[dr]!);
    if (dr < chars.length - 1) run(leftX[dr]! + widths[dr]!, leftX[dr + 1]!);
    return out;
  }

  function tick() {
    const s = getSnap();
    ensure();
    clearNeutral(ctx, s.w, s.h);
    applyMultiplyBlend(ctx, s.visual.multiplyBlend);

    const fills = dragIdx >= 0 ? gapFills(dragIdx) : [];

    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center';
    for (const f of fills) {
      ctx.globalAlpha = f.a;
      ctx.fillStyle = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: 1,
        total: 3,
      });
      ctx.fillText(f.ch, f.x, baselineY);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    for (let i = 0; i < chars.length; i++) {
      ctx.fillStyle = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: i,
        total: chars.length,
      });
      ctx.fillText(chars[i]!, leftX[i]!, baselineY);
    }
    ctx.restore();
  }

  return {
    start() {
      layoutSig = '';
      tickerFn = () => tick();
      gsap.ticker.add(tickerFn);
      down = (e: PointerEvent) => {
        if (getSnap().visual.sceneFrozen) return;
        const r = canvas.getBoundingClientRect();
        const px = e.clientX - r.left;
        dragIdx = hit(px);
        if (dragIdx >= 0) grabOffset = px - leftX[dragIdx]!;
        canvas.setPointerCapture(e.pointerId);
      };
      move = (e: PointerEvent) => {
        if (dragIdx < 0 || getSnap().visual.sceneFrozen) return;
        const r = canvas.getBoundingClientRect();
        const px = e.clientX - r.left;
        leftX[dragIdx] = px - grabOffset;
      };
      up = () => {
        dragIdx = -1;
      };
      canvas.addEventListener('pointerdown', down);
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      canvas.addEventListener('pointercancel', up);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    stop() {
      if (tickerFn) gsap.ticker.remove(tickerFn);
      tickerFn = null;
      if (down) canvas.removeEventListener('pointerdown', down);
      if (move) canvas.removeEventListener('pointermove', move);
      if (up) {
        canvas.removeEventListener('pointerup', up);
        canvas.removeEventListener('pointercancel', up);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      }
      down = move = up = null;
    },
    dispose() {
      this.stop();
    },
  };
}
