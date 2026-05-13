import gsap from 'gsap';
import { colorForGlyph, clamp } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import { separateDiscs } from '../utils/physics';
import type { ModeController, ModeSnapshot } from './types';

type B = {
  char: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
};

export function createSoftBodyMode(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let bodies: B[] = [];
  let layoutSig = '';
  let tickerFn: (() => void) | null = null;

  function rebuild() {
    const s = getSnap();
    const tw = measureLineWidth(ctx, s.text, s.fontCss, s.letterSpacing);
    const ox = (s.w - tw) * 0.5;
    const oy = s.h * 0.35;
    const lays = layoutGlyphs(ctx, s.text, s.fontCss, s.fontSize, s.letterSpacing, ox, oy);
    bodies = lays.map((g) => {
      const r = Math.max(g.w, g.h) * 0.48;
      const cx = g.x + g.w * 0.5;
      const cy = g.baseline - g.h * 0.45;
      return { char: g.char, x: cx, y: cy, vx: 0, vy: 0, r };
    });
  }

  function ensure() {
    const s = getSnap();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.w}|${s.h}`;
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
    const floor = s.h * 0.78;
    const grav = s.visual.softBody.gravity ? 0.18 : 0;
    const rep = s.visual.softBody.repulsion * 0.04;
    const soft = s.visual.softBody.softness;

    for (const b of bodies) {
      b.vy += grav;
      b.vx += (Math.random() - 0.5) * rep;
      b.vy += (Math.random() - 0.5) * rep * 0.6;
      b.vx *= 0.992;
      b.vy *= 0.992;
      b.x += b.vx;
      b.y += b.vy;
    }

    const n = bodies.length;
    const xs = new Float32Array(n);
    const ys = new Float32Array(n);
    const rs = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = bodies[i]!.x;
      ys[i] = bodies[i]!.y;
      rs[i] = bodies[i]!.r;
    }
    separateDiscs(xs, ys, rs, 1, 4);
    for (let i = 0; i < n; i++) {
      const b = bodies[i]!;
      const ox = xs[i]! - b.x;
      const oy = ys[i]! - b.y;
      b.x = xs[i]!;
      b.y = ys[i]!;
      b.vx += ox * 0.08;
      b.vy += oy * 0.08;
    }

    for (const b of bodies) {
      if (b.y + b.r > floor) {
        b.y = floor - b.r;
        b.vy *= -0.22;
        b.vx *= 0.9;
      }
      if (b.x - b.r < 0) {
        b.x = b.r;
        b.vx *= -0.35;
      }
      if (b.x + b.r > s.w) {
        b.x = s.w - b.r;
        b.vx *= -0.35;
      }
    }

    ctx.save();
    ctx.font = s.fontCss;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i]!;
      const speed = Math.hypot(b.vx, b.vy);
      const squash = clamp(speed * 0.045 + Math.abs(b.vy) * 0.025, 0, 1.4);
      const sx = 1 + soft * 0.16 * squash;
      const sy = 1 - soft * 0.2 * squash;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.scale(sx, sy);
      ctx.fillStyle = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: i,
        total: bodies.length,
      });
      ctx.fillText(b.char, 0, 0);
      ctx.restore();
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
  };
}
