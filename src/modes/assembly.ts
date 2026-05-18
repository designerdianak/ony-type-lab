import gsap from 'gsap';
import { colorForGlyph } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import type { ModeController, ModeSnapshot } from './types';
import type { AssemblySettings } from '../types/playground';

type InwardParticle = {
  char: string;
  x: number;
  y: number;
  gx: number;
  gy: number;
  vx: number;
  vy: number;
  reached: boolean;
  life: number;
  color: string;
  slot: number;
};

type LetterSystem = {
  char: string;
  tx: number;
  ty: number;
  index: number;
  particles: InwardParticle[];
};

function randomInRing(tx: number, ty: number, maxR: number, minR: number) {
  const ang = Math.random() * Math.PI * 2;
  const r = minR + Math.random() * (maxR - minR);
  return { x: tx + Math.cos(ang) * r, y: ty + Math.sin(ang) * r };
}

function roundToGrid(v: number, grid: number) {
  if (grid <= 1) return v;
  return Math.round(v / grid) * grid;
}

export function createAssemblyMode(
  _canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let systems: LetterSystem[] = [];
  let layoutSig = '';
  let tickerFn: (() => void) | null = null;
  let lastCanvasClearNonce = 0;
  let lastTickTime = performance.now();
  let frame = 0;

  function rebuild() {
    const s = getSnap();
    const asm = s.visual.assembly;
    const spacingBoost = asm.overlap ? 0 : s.fontSize * 0.06;
    const letter = s.letterSpacing + spacingBoost;
    const tw = measureLineWidth(ctx, s.text, s.fontCss, letter);
    const ox = (s.w - tw) * 0.5;
    const oy = s.h * 0.55;
    const lays = layoutGlyphs(ctx, s.text, s.fontCss, s.fontSize, letter, ox, oy);
    systems = lays.map((g, i) => ({
      char: g.char,
      tx: g.x,
      ty: g.baseline,
      index: i,
      particles: [],
    }));
  }

  function ensure() {
    const s = getSnap();
    const asm = s.visual.assembly;
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.w}|${s.h}|${asm.overlap}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      rebuild();
    }
  }

  function addParticle(sys: LetterSystem, asm: AssemblySettings, s: ModeSnapshot) {
    const fs = s.fontSize;
    const maxR = fs * (0.55 + asm.orbitRadius * 2.4);
    const minR = Math.max(fs * 0.08, maxR * 0.12);
    const start = randomInRing(sys.tx, sys.ty, maxR, minR);
    const dx = sys.tx - start.x;
    const dy = sys.ty - start.y;
    const dist = Math.hypot(dx, dy) || 1;
    const speed = fs * (0.04 + asm.mergeSpeed * 0.14);
    sys.particles.push({
      char: sys.char,
      x: start.x,
      y: start.y,
      gx: sys.tx,
      gy: sys.ty,
      vx: (dx / dist) * speed,
      vy: (dy / dist) * speed,
      reached: false,
      life: Math.round(12 + asm.inwardCopies * 2.8),
      color: colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: sys.index + Math.floor(Math.random() * 5),
        total: systems.length + 6,
      }),
      slot: sys.index,
    });
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

    const frozen = s.visual.sceneFrozen;
    const asm = s.visual.assembly;
    const fs = s.fontSize;
    const grid = Math.max(1, asm.pixelJump);
    const t = performance.now();
    const dt = Math.min(0.034, Math.max(0.008, (t - lastTickTime) / 1000));
    lastTickTime = t;
    const anim = s.animationEnabled ? 1 : 0.4;

    if (!frozen && systems.length > 0) {
      frame += 1;
      const freqFC = Math.max(5, Math.round(34 - asm.drift * 22));
      const freqRV = 0.28 + asm.drift * 0.55;

      for (const sys of systems) {
        if (frame % freqFC === sys.index && Math.random() < freqRV) {
          addParticle(sys, asm, s);
        }
      }

      const reachDist = fs * 0.11;

      for (const sys of systems) {
        for (let i = sys.particles.length - 1; i >= 0; i--) {
          const p = sys.particles[i]!;
          if (!p.reached) {
            p.x += p.vx * dt * 60 * anim;
            p.y += p.vy * dt * 60 * anim;
            if (Math.hypot(p.gx - p.x, p.gy - p.y) < reachDist) {
              p.reached = true;
              p.x = p.gx;
              p.y = p.gy;
            }
          } else if (frame % 5 === 0) {
            const jitter = grid * (0.55 + Math.random() * 0.5);
            p.x = p.gx + (Math.random() - 0.5) * jitter * 2;
            p.y = p.gy + (Math.random() - 0.5) * jitter * 2;
            p.life -= 1;
          } else {
            p.life -= dt * 2.2;
          }
          if (p.life <= 0) sys.particles.splice(i, 1);
        }
      }
    }

    const echoes = Math.max(2, Math.min(16, Math.round(asm.inwardCopies * 0.55)));
    const yShift = fs * 0.02;

    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'alphabetic';

    for (const sys of systems) {
      ctx.globalAlpha = 0.12 * anim;
      ctx.fillStyle = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: sys.index,
        total: systems.length,
      });
      ctx.fillText(sys.char, sys.tx, sys.ty + yShift);
    }

    for (const sys of systems) {
      for (const p of sys.particles) {
        const spd = Math.hypot(p.vx, p.vy);
        const ex = spd > 0.2 ? -p.vx / spd : -1;
        const ey = spd > 0.2 ? -p.vy / spd : 0;
        const fly = p.reached ? 0.35 : 1;
        const drawX = roundToGrid(p.x, grid);
        const drawY = roundToGrid(p.y + yShift, grid);

        for (let k = echoes; k >= 1; k--) {
          const trail = k / echoes;
          const lag = (4 + asm.orbitRadius * 10) * trail * fly;
          ctx.globalAlpha = fly * (0.06 + 0.2 * (1 - trail)) * anim;
          ctx.fillStyle = p.color;
          ctx.fillText(p.char, drawX + ex * lag, drawY + ey * lag);
        }

        ctx.globalAlpha = (p.reached ? 0.75 : 0.92) * anim;
        ctx.fillStyle = p.color;
        ctx.fillText(p.char, drawX, drawY);
      }
    }
    ctx.restore();
  }

  return {
    start() {
      layoutSig = '';
      frame = 0;
      lastCanvasClearNonce = getSnap().visual.canvasClearNonce ?? 0;
      lastTickTime = performance.now();
      rebuild();
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
