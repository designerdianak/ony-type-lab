import gsap from 'gsap';
import { colorForGlyph, lerp } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import { separateDiscs } from '../utils/physics';
import type { ModeController, ModeSnapshot } from './types';

type Ent = {
  char: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  hx: number;
  hy: number;
};

export function createExpansionMode(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let ents: Ent[] = [];
  let lastText = '';
  let lastFont = '';
  let lastSize = 0;
  let lastSpacing = 0;
  let tickerFn: (() => void) | null = null;
  let clickHandler: ((e: MouseEvent) => void) | null = null;
  let autoTimer = 0;

  function rebuildIfNeeded(force = false) {
    const s = getSnap();
    const fontCss = s.fontCss;
    if (
      !force &&
      s.text === lastText &&
      fontCss === lastFont &&
      s.fontSize === lastSize &&
      s.letterSpacing === lastSpacing
    ) {
      return;
    }
    lastText = s.text;
    lastFont = fontCss;
    lastSize = s.fontSize;
    lastSpacing = s.letterSpacing;
    const tw = measureLineWidth(ctx, s.text, fontCss, s.letterSpacing);
    const ox = (s.w - tw) * 0.5;
    const oy = s.h * 0.55;
    const lays = layoutGlyphs(ctx, s.text, fontCss, s.fontSize, s.letterSpacing, ox, oy);
    ents = lays.map((g) => {
      const r = Math.max(g.w, g.h) * 0.52;
      const cx = g.x + g.w * 0.5;
      const cy = g.baseline - g.h * 0.45;
      return {
        char: g.char,
        x: cx,
        y: cy,
        vx: 0,
        vy: 0,
        r,
        hx: cx,
        hy: cy,
      };
    });
  }

  function hitIndex(px: number, py: number): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i]!;
      const d = Math.hypot(e.x - px, e.y - py);
      if (d < e.r && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  function cloneFrom(idx: number, px: number, py: number) {
    const s = getSnap();
    if (s.visual.sceneFrozen) return;
    const base = ents[idx]!;
    const amt = Math.max(1, Math.round(s.visual.expansion.cloneAmount));
    /** Плотный «сгусток» как на референсе: почти в одной точке, сразу давит на соседей */
    for (let k = 0; k < amt; k++) {
      const ang = (k / Math.max(1, amt)) * Math.PI * 2 + Math.random() * 0.35;
      const dist = 0.15 + Math.random() * 2.2;
      const nx = base.x + Math.cos(ang) * dist;
      const ny = base.y + Math.sin(ang) * dist;
      const burst = s.visual.expansion.spreadForce * (9 + Math.random() * 5);
      ents.push({
        char: base.char,
        x: nx,
        y: ny,
        vx: Math.cos(ang) * burst,
        vy: Math.sin(ang) * burst,
        r: base.r,
        hx: base.hx + (Math.random() - 0.5) * 2,
        hy: base.hy,
      });
    }
    const push = s.visual.expansion.spreadForce * 14;
    for (const e of ents) {
      const dx = e.x - px;
      const dy = e.y - py;
      const d = Math.hypot(dx, dy) + 0.01;
      e.vx += (dx / d) * push * 0.11;
      e.vy += (dy / d) * push * 0.11;
    }
  }

  function tick() {
    const s = getSnap();
    rebuildIfNeeded();
    clearNeutral(ctx, s.w, s.h);
    applyMultiplyBlend(ctx, s.visual.multiplyBlend);

    const sets = s.visual.expansion;
    const n = ents.length;
    if (n === 0) return;

    const frozen = s.visual.sceneFrozen;

    const xs = new Float32Array(n);
    const ys = new Float32Array(n);
    const rs = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = ents[i]!.x;
      ys[i] = ents[i]!.y;
      rs[i] = ents[i]!.r;
    }
    const impulse = 0.22 + sets.collisionImpulse * 0.62;
    separateDiscs(xs, ys, rs, sets.collisionSpacing, 10);
    separateDiscs(xs, ys, rs, sets.collisionSpacing, 6);

    if (!frozen) {
      for (let i = 0; i < n; i++) {
        const e = ents[i]!;
        const ox = xs[i]! - e.x;
        const oy = ys[i]! - e.y;
        e.vx += ox * impulse;
        e.vy += oy * impulse;
      }

      for (let i = 0; i < n; i++) {
        const e = ents[i]!;
        const tx = xs[i]!;
        const ty = ys[i]!;
        e.vx = lerp(e.vx, (tx - e.x) * sets.spreadForce * 0.32, 0.2);
        e.vy = lerp(e.vy, (ty - e.y) * sets.spreadForce * 0.32, 0.2);
        e.vx += (e.hx - e.x) * 0.00045;
        e.vy += (e.hy - e.y) * 0.00075;
        if (s.animationEnabled) {
          e.vx += Math.sin(performance.now() * 0.0005 + i) * 0.008;
          e.vy += Math.cos(performance.now() * 0.00045 + i * 0.7) * 0.007;
        }
        e.x += e.vx;
        e.y += e.vy;
        e.vx *= 0.905;
        e.vy *= 0.905;
      }

      if (sets.autoGrow && s.animationEnabled) {
        autoTimer += 1;
        if (autoTimer > 220 && ents.length > 0) {
          autoTimer = 0;
          const idx = Math.floor(Math.random() * ents.length);
          cloneFrom(idx, s.w * 0.5, s.h * 0.5);
        }
      }
    }

    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i]!;
      const fill = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: i,
        total: ents.length,
      });
      ctx.fillStyle = fill;
      ctx.fillText(e.char, e.x, e.y);
    }
    ctx.restore();
  }

  return {
    start() {
      rebuildIfNeeded(true);
      tickerFn = () => tick();
      gsap.ticker.add(tickerFn);
      clickHandler = (ev: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        const px = ev.clientX - rect.left;
        const py = ev.clientY - rect.top;
        const idx = hitIndex(px, py);
        if (idx >= 0) cloneFrom(idx, px, py);
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
