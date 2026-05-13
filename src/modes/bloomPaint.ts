import gsap from 'gsap';
import { hsla, lerp, randomVividPalette, smoothstep } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import type { ModeController, ModeSnapshot } from './types';

type Shape = {
  kind: 0 | 1 | 2;
  ax: number;
  ay: number;
  w: number;
  h: number;
  rot: number;
  born: number;
  sway: number;
  hueA: number;
  hueB: number;
  peak: number;
};

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

export function createBloomPaintMode(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let shapes: Shape[] = [];
  let painting = false;
  let lastPaint = 0;
  let paletteHue = 0;
  let tickerFn: (() => void) | null = null;
  let homes: { x: number; y: number; ox: number; oy: number; char: string; w: number; h: number; bl: number }[] = [];
  let lastMouseX = 0;
  let lastMouseY = 0;
  let layoutSig = '';

  function syncHomes() {
    const s = getSnap();
    const tw = measureLineWidth(ctx, s.text, s.fontCss, s.letterSpacing);
    const ox = (s.w - tw) * 0.5;
    const oy = s.h * 0.55;
    const lays = layoutGlyphs(ctx, s.text, s.fontCss, s.fontSize, s.letterSpacing, ox, oy);
    homes = lays.map((g) => ({
      x: g.x,
      y: g.y,
      ox: 0,
      oy: 0,
      char: g.char,
      w: g.w,
      h: g.h,
      bl: g.baseline,
    }));
  }

  function ensureLayout() {
    const s = getSnap();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.w}|${s.h}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      syncHomes();
    }
  }

  function spawnShape(px: number, py: number) {
    const s = getSnap();
    const b = s.visual.bloom;
    const now = performance.now();
    const kind = (Math.floor(Math.random() * 3) % 3) as 0 | 1 | 2;
    const hues = randomVividPalette(s.visual.rainbowSeed + paletteHue * 0.01, 4);
    const pick = hues[Math.floor(Math.random() * hues.length)]!;
    const m = /hsla\(([\d.]+),/i.exec(pick);
    const ha = m ? Number(m[1]) : Math.random() * 360;
    paletteHue += 1;
    shapes.push({
      kind,
      ax: px,
      ay: py,
      w: 8 + Math.random() * 18 * b.shapeSize,
      h: 0.001,
      rot: (Math.random() - 0.5) * 0.35,
      born: now,
      sway: Math.random() * Math.PI * 2,
      hueA: ha,
      hueB: ha + 40 + Math.random() * 80,
      peak: 0.55 + Math.random() * 0.35,
    });
  }

  function applyLetterBloomForce(sx: number, sy: number, strength: number) {
    for (const h of homes) {
      const cx = h.x + h.w * 0.5;
      const cy = h.bl - h.h * 0.45;
      const d = Math.hypot(cx - sx, cy - sy);
      const fall = smoothstep(120, 0, d);
      const ang = Math.atan2(cy - sy, cx - sx);
      const push = strength * fall * 0.9;
      h.ox += Math.cos(ang) * push;
      h.oy += Math.sin(ang) * push;
    }
  }

  function drawShape(sh: Shape, t: number) {
    const s = getSnap();
    const b = s.visual.bloom;
    const age = (t - sh.born) / 1000;
    const grow = easeOutQuad(Math.min(1, age * 1.4 * b.growSpeed));
    const targetH = (40 + sh.peak * 90) * b.shapeSize;
    sh.h = lerp(0.001, targetH, grow);
    const dissolve = Math.max(0, 1 - Math.max(0, age - 0.35 * b.growSpeed) * b.dissolveSpeed * 0.55);
    sh.rot += Math.sin(t * 0.0011 + sh.sway) * 0.0022 * b.motionIntensity;
    const swayX = Math.sin(t * 0.0013 + sh.sway) * 6 * b.motionIntensity;
    const g = ctx.createLinearGradient(
      sh.ax - sh.w,
      sh.ay - sh.h,
      sh.ax + sh.w + swayX,
      sh.ay - sh.h * 1.2,
    );
    g.addColorStop(0, hsla(sh.hueA, 92, 58, 0.85 * dissolve));
    g.addColorStop(1, hsla(sh.hueB, 90, 52, 0.35 * dissolve));
    ctx.save();
    ctx.translate(sh.ax + swayX, sh.ay);
    ctx.rotate(sh.rot);
    ctx.globalAlpha = 0.15 + 0.75 * dissolve;
    const prevComp = ctx.globalCompositeOperation;
    if (b.multiply) ctx.globalCompositeOperation = 'multiply';
    else ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.beginPath();
    if (sh.kind === 0) {
      ctx.ellipse(0, -sh.h * 0.5, sh.w * 0.55, sh.h * 0.5, 0, 0, Math.PI * 2);
    } else if (sh.kind === 1) {
      const rw = sh.w;
      const rh = sh.h;
      const rr = Math.min(rw, rh) * 0.28;
      ctx.roundRect(-rw * 0.5, -rh, rw, rh, rr);
    } else {
      const rw = sh.w * 1.1;
      const rh = sh.h * 0.85;
      ctx.roundRect(-rw * 0.5, -rh, rw, rh, rh * 0.5);
    }
    ctx.fill();
    ctx.globalCompositeOperation = prevComp;
    ctx.restore();
  }

  function tick() {
    const s = getSnap();
    ensureLayout();
    clearNeutral(ctx, s.w, s.h);
    const mult = s.visual.multiplyBlend || s.visual.bloom.multiply;
    applyMultiplyBlend(ctx, mult);

    const t = performance.now();
    ctx.save();
    if (s.visual.bloom.blur) ctx.filter = 'blur(7px)';
    else ctx.filter = 'none';
    shapes = shapes.filter((sh) => t - sh.born < 5200);
    for (const sh of shapes) drawShape(sh, t);
    ctx.restore();

    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'alphabetic';
    for (const h of homes) {
      h.ox = lerp(h.ox, 0, 0.04);
      h.oy = lerp(h.oy, 0, 0.045);
      ctx.fillStyle = '#0a0a0a';
      ctx.fillText(h.char, h.x + h.ox, h.bl + h.oy);
    }
    ctx.restore();

    if (painting) {
      const dt = t - lastPaint;
      if (dt > 28) {
        lastPaint = t;
        const lx = lastMouseX;
        const ly = lastMouseY;
        spawnShape(lx, ly);
        applyLetterBloomForce(lx, ly, 10 * s.visual.bloom.motionIntensity);
      }
    }
  }

  function onDown(e: PointerEvent) {
    painting = true;
    const r = canvas.getBoundingClientRect();
    lastMouseX = e.clientX - r.left;
    lastMouseY = e.clientY - r.top;
    lastPaint = performance.now();
  }
  function onUp() {
    painting = false;
  }
  function onMove(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    lastMouseX = e.clientX - r.left;
    lastMouseY = e.clientY - r.top;
  }

  return {
    start() {
      layoutSig = '';
      syncHomes();
      tickerFn = () => tick();
      gsap.ticker.add(tickerFn);
      canvas.addEventListener('pointerdown', onDown);
      window.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointermove', onMove);
    },
    stop() {
      if (tickerFn) gsap.ticker.remove(tickerFn);
      tickerFn = null;
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointermove', onMove);
    },
    dispose() {
      this.stop();
    },
  };
}
