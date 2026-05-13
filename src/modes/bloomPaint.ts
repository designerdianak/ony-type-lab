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
  stemPhase: number;
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
  let homes: {
    x: number;
    y: number;
    ox: number;
    oy: number;
    vx: number;
    vy: number;
    char: string;
    w: number;
    h: number;
    bl: number;
  }[] = [];
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
      vx: 0,
      vy: 0,
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

  function fieldPressure(px: number, py: number, t: number): number {
    let p = 0;
    for (const sh of shapes) {
      const age = (t - sh.born) / 1000;
      const dissolve = Math.max(0, 1 - Math.max(0, age - 0.25) * 0.55);
      const dx = px - (sh.ax + Math.sin(t * 0.0009 + sh.stemPhase) * 8);
      const dy = py - (sh.ay - sh.h * 0.4);
      const d = Math.hypot(dx, dy);
      p += smoothstep(95, 0, d) * (0.2 + dissolve * 0.85);
    }
    const cx = lastMouseX;
    const cy = lastMouseY;
    const cd = Math.hypot(px - cx, py - cy);
    p += smoothstep(100, 0, cd) * 0.35 * (painting ? 1 : 0.45);
    return Math.min(2.2, p);
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
      rot: (Math.random() - 0.5) * 0.25,
      born: now,
      sway: Math.random() * Math.PI * 2,
      hueA: ha,
      hueB: ha + 40 + Math.random() * 80,
      peak: 0.55 + Math.random() * 0.35,
      stemPhase: Math.random() * Math.PI * 2,
    });
  }

  function drawShape(sh: Shape, t: number) {
    const s = getSnap();
    const b = s.visual.bloom;
    const frozen = s.visual.sceneFrozen;
    const age = (t - sh.born) / 1000;
    const grow = easeOutQuad(Math.min(1, age * 1.2 * b.growSpeed));
    const targetH = (40 + sh.peak * 90) * b.shapeSize;
    if (!frozen) sh.h = lerp(0.001, targetH, grow);
    const fadeStart = 0.28 + (1 - b.graphicFade) * 0.45;
    const dissolve = Math.max(0, 1 - Math.max(0, age - fadeStart) * b.dissolveSpeed * 0.5);
    const plant = b.plantOrganic;
    const bend = Math.sin(t * 0.001 + sh.stemPhase) * 0.12 * plant;
    const swaySlow = Math.sin(t * 0.00055 + sh.sway) * 14 * plant * b.motionIntensity;
    const swayFast = Math.cos(t * 0.0018 + sh.sway * 1.3) * 5 * plant;
    if (!frozen) sh.rot += bend * 0.018 + swayFast * 0.0004;
    const swayX = swaySlow + swayFast;
    const swayY = Math.sin(t * 0.0007 + sh.stemPhase) * 10 * plant;

    const g = ctx.createLinearGradient(
      sh.ax - sh.w,
      sh.ay - sh.h + swayY,
      sh.ax + sh.w + swayX,
      sh.ay - sh.h * 1.25 + swayY,
    );
    g.addColorStop(0, hsla(sh.hueA, 92, 58, 0.85 * dissolve));
    g.addColorStop(1, hsla(sh.hueB, 90, 52, 0.32 * dissolve));
    ctx.save();
    ctx.translate(sh.ax + swayX, sh.ay + swayY * 0.35);
    ctx.rotate(sh.rot);
    ctx.globalAlpha = 0.12 + 0.78 * dissolve;
    const prevComp = ctx.globalCompositeOperation;
    if (b.multiply) ctx.globalCompositeOperation = 'multiply';
    else ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.beginPath();
    if (sh.kind === 0) {
      ctx.ellipse(0, -sh.h * 0.5, sh.w * 0.55, sh.h * 0.5, bend * 0.4, 0, Math.PI * 2);
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
    const frozen = s.visual.sceneFrozen;
    const b = s.visual.bloom;

    if (!frozen) {
      shapes = shapes.filter((sh) => t - sh.born < 5200 + b.graphicFade * 4000);
    }

    ctx.save();
    if (s.visual.bloom.blur) ctx.filter = 'blur(7px)';
    else ctx.filter = 'none';
    for (const sh of shapes) drawShape(sh, t);
    ctx.restore();

    const returnK = 0.04 + b.letterReturn * 0.14;
    if (!frozen) {
      for (const h of homes) {
        const cx = h.x + h.w * 0.5;
        const cy = h.bl - h.h * 0.45;
        const pr = fieldPressure(cx, cy, t);
        const ang = Math.atan2(cy - lastMouseY, cx - lastMouseX) || 0;
        const push = pr * (18 + b.motionIntensity * 32);
        h.vx += Math.cos(ang) * push * 0.014;
        h.vy += Math.sin(ang) * push * 0.014;
        h.vx += -h.ox * returnK * (0.35 + pr * 0.2);
        h.vy += -h.oy * returnK * (0.35 + pr * 0.2);
        h.ox += h.vx;
        h.oy += h.vy;
        h.vx *= 0.88;
        h.vy *= 0.88;
        const hide = pr > 0.85 ? 0.08 : 1;
        h.ox *= hide;
        h.oy *= hide;
      }

      const spawnGap = Math.round(lerp(88, 10, b.figureDensity));
      if (painting) {
        const dt = t - lastPaint;
        if (dt > spawnGap) {
          lastPaint = t;
          spawnShape(lastMouseX, lastMouseY);
        }
      }
    }

    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'alphabetic';
    for (const h of homes) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#0a0a0a';
      ctx.fillText(h.char, h.x + h.ox, h.bl + h.oy);
    }
    ctx.restore();
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
