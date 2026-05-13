import gsap from 'gsap';
import { colorForGlyph, clamp, hsla } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { separateDiscs } from '../utils/physics';
import type { ModeController, ModeSnapshot } from './types';

type D = {
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
  let queue: string[] = [];
  let stack: D[] = [];
  let tickerFn: (() => void) | null = null;
  let clickHandler: ((e: MouseEvent) => void) | null = null;
  let fontSig = '';

  function syncQueue() {
    const s = getSnap();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}`;
    if (sig === fontSig) return;
    fontSig = sig;
    queue = s.text.split('').filter((c) => c.trim().length > 0);
    stack = [];
  }

  function measureR(ch: string): number {
    const s = getSnap();
    ctx.save();
    ctx.font = s.fontCss;
    const m = ctx.measureText(ch);
    const w = m.width;
    const h =
      (m.actualBoundingBoxAscent || 0) + (m.actualBoundingBoxDescent || 0) || s.fontSize * 0.85;
    ctx.restore();
    return Math.max(w, h) * 0.48;
  }

  function drawMetallicLetter(ch: string, x: number, y: number, i: number) {
    const s = getSnap();
    const look = s.visual.softBody.look;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (look === 'matte') {
      ctx.fillStyle = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: i,
        total: 8,
      });
      ctx.fillText(ch, x, y);
      ctx.restore();
      return;
    }
    const hue = s.visual.colorMode === 'rainbow' ? (s.visual.rainbowSeed * 40 + i * 35) % 360 : 210;
    for (let k = 5; k >= 1; k--) {
      ctx.globalAlpha = 0.12 + k * 0.06;
      ctx.fillStyle = hsla(hue, 8, 18 + k * 6, 1);
      ctx.fillText(ch, x + k * 0.9, y + k * 0.85);
    }
    const g = ctx.createLinearGradient(x - 40, y - 50, x + 50, y + 40);
    g.addColorStop(0, hsla(hue, 18, 72, 1));
    g.addColorStop(0.45, hsla(hue, 35, 88, 1));
    g.addColorStop(0.55, hsla(hue, 40, 55, 1));
    g.addColorStop(1, hsla(hue, 25, 38, 1));
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fillText(ch, x, y);
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(ch, x - s.fontSize * 0.04, y - s.fontSize * 0.08);
    ctx.restore();
  }

  function tick() {
    const s = getSnap();
    syncQueue();
    clearNeutral(ctx, s.w, s.h);
    applyMultiplyBlend(ctx, s.visual.multiplyBlend);
    const floor = s.h * 0.82;
    const frozen = s.visual.sceneFrozen;
    const grav = s.visual.softBody.gravity ? 0.28 : 0;
    const soft = s.visual.softBody.softness;
    const rep = s.visual.softBody.repulsion * 0.03;

    if (!frozen) {
      for (const b of stack) {
        b.vy += grav;
        b.vx += (Math.random() - 0.5) * rep;
        b.vy += (Math.random() - 0.5) * rep * 0.5;
        b.vx *= 0.991;
        b.vy *= 0.991;
        b.x += b.vx;
        b.y += b.vy;
      }
      const n = stack.length;
      const xs = new Float32Array(n);
      const ys = new Float32Array(n);
      const rs = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        xs[i] = stack[i]!.x;
        ys[i] = stack[i]!.y;
        rs[i] = stack[i]!.r;
      }
      separateDiscs(xs, ys, rs, 0.5, 5);
      for (let i = 0; i < n; i++) {
        const b = stack[i]!;
        const ox = xs[i]! - b.x;
        const oy = ys[i]! - b.y;
        b.x = xs[i]!;
        b.y = ys[i]!;
        b.vx += ox * 0.06;
        b.vy += oy * 0.06;
      }
      for (const b of stack) {
        if (b.y + b.r > floor) {
          b.y = floor - b.r;
          b.vy *= -0.18;
          b.vx *= 0.88;
        }
        if (b.x - b.r < 0) {
          b.x = b.r;
          b.vx *= -0.3;
        }
        if (b.x + b.r > s.w) {
          b.x = s.w - b.r;
          b.vx *= -0.3;
        }
      }
    }

    ctx.save();
    ctx.font = s.fontCss;
    for (let i = 0; i < stack.length; i++) {
      const b = stack[i]!;
      const speed = Math.hypot(b.vx, b.vy);
      const squash = clamp(speed * 0.04 + Math.abs(b.vy) * 0.02, 0, 1.2);
      const sx = 1 + soft * 0.14 * squash;
      const sy = 1 - soft * 0.18 * squash;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.scale(sx, sy);
      drawMetallicLetter(b.char, 0, 0, i);
      ctx.restore();
    }
    ctx.restore();
  }

  return {
    start() {
      fontSig = '';
      stack = [];
      tickerFn = () => tick();
      gsap.ticker.add(tickerFn);
      clickHandler = (ev: MouseEvent) => {
        const s = getSnap();
        if (s.visual.sceneFrozen || queue.length === 0) return;
        const r = canvas.getBoundingClientRect();
        const px = ev.clientX - r.left;
        const ch = queue.shift()!;
        const rad = measureR(ch);
        stack.push({ char: ch, x: px, y: 70 + Math.random() * 20, vx: (Math.random() - 0.5) * 1.2, vy: 0.5, r: rad });
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
