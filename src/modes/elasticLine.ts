import gsap from 'gsap';
import { colorForGlyph, lerp } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import type { ModeController, ModeSnapshot } from './types';

export function createElasticLineMode(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let chars: string[] = [];
  let xs: number[] = [];
  let baselineY = 0;
  let widths: number[] = [];
  let layoutSig = '';
  let dragIdx = -1;
  let pointerX = 0;
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
    xs = lays.map((g) => g.x + g.w * 0.5);
    baselineY = lays[0]?.baseline ?? oy;
  }

  function ensure() {
    const s = getSnap();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.w}|${s.h}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      rebuild();
    }
  }

  function relax() {
    const s = getSnap();
    const k = s.visual.elastic.springK * s.visual.elastic.damping * (s.animationEnabled ? 1 : 0.75);
    const nx = xs.slice();
    for (let i = 0; i < xs.length; i++) {
      if (i === dragIdx) continue;
      const left = i > 0 ? xs[i - 1]! : xs[i]!;
      const right = i < xs.length - 1 ? xs[i + 1]! : xs[i]!;
      const target = (left + right) * 0.5;
      nx[i] = lerp(xs[i]!, target, k);
    }
    if (dragIdx >= 0) nx[dragIdx] = pointerX;
    for (let i = 0; i < xs.length; i++) xs[i] = nx[i]!;
  }

  function copiesAlongDrag(): { x: number; y: number; a: number }[] {
    const s = getSnap();
    if (dragIdx < 0 || chars.length === 0) return [];
    const w = widths[dragIdx] ?? s.fontSize * 0.5;
    const spacing = Math.max(6, w * s.visual.elastic.copySpacing);
    const out: { x: number; y: number; a: number }[] = [];
    const i0 = Math.max(0, dragIdx - 1);
    const i1 = Math.min(chars.length - 1, dragIdx + 1);
    const x0 = xs[i0]!;
    const x1 = xs[i1]!;
    const xm = xs[dragIdx]!;
    const total = Math.abs(xm - x0) + Math.abs(x1 - xm);
    if (total < spacing * 1.2) return out;
    const walk = (xa: number, xb: number) => {
      const dir = Math.sign(xb - xa) || 1;
      let t = xa + dir * spacing * 0.5;
      const end = xb - dir * spacing * 0.35;
      while (dir > 0 ? t < end : t > end) {
        out.push({ x: t, y: baselineY, a: 0.22 });
        t += dir * spacing;
      }
    };
    walk(x0, xm);
    walk(xm, x1);
    return out;
  }

  function tick() {
    const s = getSnap();
    ensure();
    for (let k = 0; k < 4; k++) relax();
    clearNeutral(ctx, s.w, s.h);
    applyMultiplyBlend(ctx, s.visual.multiplyBlend);

    const extras = copiesAlongDrag();
    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center';
    for (const e of extras) {
      ctx.globalAlpha = e.a;
      ctx.fillStyle = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: 0,
        total: 1,
      });
      ctx.fillText(chars[dragIdx]!, e.x, e.y);
    }
    ctx.globalAlpha = 1;
    for (let i = 0; i < chars.length; i++) {
      const fill = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: i,
        total: chars.length,
      });
      ctx.fillStyle = fill;
      const jitter = s.animationEnabled ? Math.sin(performance.now() * 0.001 + i) * 0.4 : 0;
      ctx.fillText(chars[i]!, xs[i]! - widths[i]! * 0.5 + jitter, baselineY);
    }
    ctx.restore();
  }

  function nearestIndex(px: number): number {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs(xs[i]! - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  return {
    start() {
      layoutSig = '';
      tickerFn = () => tick();
      gsap.ticker.add(tickerFn);
      down = (e: PointerEvent) => {
        const r = canvas.getBoundingClientRect();
        pointerX = e.clientX - r.left;
        dragIdx = nearestIndex(pointerX);
        canvas.setPointerCapture(e.pointerId);
      };
      move = (e: PointerEvent) => {
        if (dragIdx < 0) return;
        const r = canvas.getBoundingClientRect();
        pointerX = e.clientX - r.left;
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
