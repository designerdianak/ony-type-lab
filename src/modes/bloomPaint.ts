import gsap from 'gsap';
import { colorForGlyph, smoothstep } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import type { ModeController, ModeSnapshot } from './types';
import type { BloomSettings } from '../types/playground';

type Glyph = {
  char: string;
  x: number;
  y: number;
  w: number;
  h: number;
  bl: number;
  ox: number;
  oy: number;
  vx: number;
  vy: number;
  rot: number;
  index: number;
};

type TrailKind = 0 | 1;

type TrailFragment = {
  kind: TrailKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  born: number;
  life: number;
  color: string;
};

const MAX_TRAILS = 520;

export function createBloomPaintMode(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let glyphs: Glyph[] = [];
  let trails: TrailFragment[] = [];
  let layoutSig = '';
  let lastClearNonce = 0;
  let lastTickTime = performance.now();
  let mouseX = -1e4;
  let mouseY = -1e4;
  let tickerFn: (() => void) | null = null;

  function resetLayout() {
    const s = getSnap();
    const tw = measureLineWidth(ctx, s.text, s.fontCss, s.letterSpacing);
    const ox = (s.w - tw) * 0.5;
    const oy = s.h * 0.55;
    const lays = layoutGlyphs(ctx, s.text, s.fontCss, s.fontSize, s.letterSpacing, ox, oy);
    glyphs = lays.map((g, i) => ({
      char: g.char,
      x: g.x,
      y: g.y,
      w: g.w,
      h: g.h,
      bl: g.baseline,
      ox: 0,
      oy: 0,
      vx: 0,
      vy: 0,
      rot: 0,
      index: i,
    }));
  }

  function ensureLayout() {
    const s = getSnap();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.w}|${s.h}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      resetLayout();
    }
  }

  function syncClear() {
    const n = getSnap().visual.canvasClearNonce ?? 0;
    if (n !== lastClearNonce) {
      lastClearNonce = n;
      trails = [];
      for (const g of glyphs) {
        g.ox = g.oy = 0;
        g.vx = g.vy = 0;
        g.rot = 0;
      }
    }
  }

  function glyphCenter(g: Glyph) {
    return { cx: g.x + g.w * 0.5 + g.ox, cy: g.bl - g.h * 0.42 + g.oy };
  }

  function spawnTrail(
    cx: number,
    cy: number,
    vx: number,
    vy: number,
    speed: number,
    b: BloomSettings,
    s: ModeSnapshot,
    glyphIndex: number,
  ) {
    if (trails.length >= MAX_TRAILS) trails.shift();

    const sp = Math.max(0.001, speed);
    const nx = -vx / sp;
    const ny = -vy / sp;
    const perpX = -ny;
    const perpY = nx;

    const variance = b.trailSizeVariance;
    const base = s.fontSize * (0.055 + b.trailAmount * 0.04);
    const w =
      base *
      (0.75 + Math.random() * 0.35 * variance) *
      (1 + b.trailStretch * Math.min(1.8, sp * 0.04));
    const h =
      base *
      (0.45 + Math.random() * 0.25 * variance) *
      (b.trailStretch > 0.5 ? 0.85 : 1);

    const lag = 4 + sp * 0.35;
    const jitter = (Math.random() - 0.5) * base * 0.4;
    const x = cx + nx * lag + perpX * jitter;
    const y = cy + ny * lag + perpY * jitter;

    const kind: TrailKind = Math.random() < 0.72 ? 0 : 1;
    const rot = Math.atan2(vy, vx) + (Math.random() - 0.5) * 0.22 * (1 + variance);

    trails.push({
      kind,
      x,
      y,
      w,
      h,
      rot,
      born: performance.now(),
      life: 280 + b.trailLifetime * 2200,
      color: colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: glyphIndex + Math.floor(Math.random() * 3),
        total: glyphs.length + 4,
      }),
    });
  }

  function updateGlyphs(dt: number, t: number, frozen: boolean) {
    if (frozen) return;
    const s = getSnap();
    const b = s.visual.bloom;
    const fs = s.fontSize;
    const radius = fs * (0.55 + b.interactionRadius * 1.15);
    const maxPush = fs * (0.08 + b.displacementStrength * 0.38);
    const springK = 1.8 + b.returnSpeed * 12;
    const damp = 1.1 + b.returnSpeed * 3.2;
    const trailSpdGate = 1.5 + b.trailAmount * 18;

    for (const g of glyphs) {
      const { cx, cy } = glyphCenter(g);
      const dx = cx - mouseX;
      const dy = cy - mouseY;
      const dist = Math.hypot(dx, dy);
      const disp = Math.hypot(g.ox, g.oy);

      if (dist < radius && dist > 0.5) {
        const influence = smoothstep(radius, radius * 0.12, dist);
        const falloff = influence * influence;
        const push = maxPush * falloff;
        g.vx += (dx / dist) * push * 48 * dt;
        g.vy += (dy / dist) * push * 48 * dt;

        if (b.trailAmount > 0.02 && (disp > fs * 0.012 || falloff > 0.2)) {
          const pushVx = (dx / dist) * push * 12;
          const pushVy = (dy / dist) * push * 12;
          const emitN = Math.min(3, 1 + Math.floor(falloff * disp * 0.08));
          for (let i = 0; i < emitN; i++) {
            spawnTrail(cx, cy, pushVx + g.vx, pushVy + g.vy, Math.max(8, disp * 14), b, s, g.index);
          }
        }
      }

      g.vx += (-g.ox * springK - g.vx * damp) * dt;
      g.vy += (-g.oy * springK - g.vy * damp) * dt;
      g.ox += g.vx * dt;
      g.oy += g.vy * dt;

      const speed = Math.hypot(g.vx, g.vy);
      const motion = Math.max(speed, disp * 22);
      if (motion > trailSpdGate && b.trailAmount > 0.02) {
        const emitRate = b.trailAmount * (0.55 + Math.min(2.2, motion * 0.028));
        const count = Math.min(6, Math.floor(emitRate * motion * dt * 0.14));
        for (let i = 0; i < count; i++) {
          spawnTrail(cx, cy, g.vx, g.vy, motion, b, s, g.index);
        }
      }

      const micro = (1 - smoothstep(0, maxPush * 0.5, Math.hypot(g.ox, g.oy))) * 0.0004;
      g.rot += Math.sin(t * 0.001 + g.index) * micro * speed;
      g.rot *= 1 - 4 * dt;
    }
  }

  function drawTrails(now: number) {
    const b = getSnap().visual.bloom;
    for (const tr of trails) {
      const age = now - tr.born;
      const lifeT = Math.min(1, age / tr.life);
      const alpha = (1 - lifeT) * (1 - lifeT) * 0.42 * (0.65 + b.trailAmount * 0.35);
      if (alpha < 0.01) continue;

      ctx.save();
      ctx.translate(tr.x, tr.y);
      ctx.rotate(tr.rot);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = tr.color;
      ctx.globalCompositeOperation = 'source-over';

      if (tr.kind === 0) {
        const rw = tr.w;
        const rh = tr.h;
        const rr = Math.min(rw, rh) * 0.22;
        ctx.beginPath();
        ctx.roundRect(-rw * 0.5, -rh * 0.5, rw, rh, rr);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.ellipse(0, 0, tr.w * 0.48, tr.h * 0.42, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function drawGlyphs() {
    const s = getSnap();
    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'alphabetic';
    for (const g of glyphs) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: g.index,
        total: glyphs.length,
      });
      ctx.save();
      ctx.translate(g.x + g.ox, g.bl + g.oy);
      ctx.rotate(g.rot);
      ctx.fillText(g.char, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  function tick() {
    const s = getSnap();
    ensureLayout();
    syncClear();

    clearNeutral(ctx, s.w, s.h, s.visual.stageBackground);
    applyMultiplyBlend(ctx, s.visual.multiplyBlend);

    const now = performance.now();
    const dt = Math.min(0.034, Math.max(0.008, (now - lastTickTime) / 1000));
    lastTickTime = now;
    const frozen = s.visual.sceneFrozen;

    if (!frozen) {
      trails = trails.filter((tr) => now - tr.born < tr.life);
      updateGlyphs(dt, now, false);
    }

    drawTrails(now);
    drawGlyphs();
  }

  function updateMouse(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    mouseX = e.clientX - r.left;
    mouseY = e.clientY - r.top;
  }

  function onPointerMove(e: PointerEvent) {
    updateMouse(e);
  }

  function onPointerLeave() {
    mouseX = -1e4;
    mouseY = -1e4;
  }

  return {
    start() {
      layoutSig = '';
      trails = [];
      lastClearNonce = getSnap().visual.canvasClearNonce ?? 0;
      lastTickTime = performance.now();
      mouseX = canvas.width * 0.5;
      mouseY = canvas.height * 0.5;
      resetLayout();
      tickerFn = () => tick();
      gsap.ticker.add(tickerFn);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerleave', onPointerLeave);
    },
    stop() {
      if (tickerFn) gsap.ticker.remove(tickerFn);
      tickerFn = null;
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
    },
    dispose() {
      this.stop();
    },
    interruptInteraction() {
      onPointerLeave();
    },
  };
}
