import gsap from 'gsap';
import { colorForGlyph } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import type { ModeController, ModeSnapshot } from './types';

type RootGlyph = {
  char: string;
  x: number;
  y: number;
  abl: number;
  abr: number;
  aba: number;
  abd: number;
};

type WaterDrop = {
  char: string;
  slot: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  alpha: number;
  abl: number;
  abr: number;
  aba: number;
  abd: number;
  phase: number;
};

function inkMetrics(ctx: CanvasRenderingContext2D, char: string, fontCss: string) {
  ctx.save();
  ctx.font = fontCss;
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText(char);
  const abl = m.actualBoundingBoxLeft ?? 0;
  const abr = m.actualBoundingBoxRight ?? m.width;
  const aba = m.actualBoundingBoxAscent ?? 0;
  const abd = m.actualBoundingBoxDescent ?? 0;
  ctx.restore();
  return { abl, abr, aba, abd };
}

export function createExpansionMode(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let roots: RootGlyph[] = [];
  let drops: WaterDrop[] = [];
  /** слоты с включённым водопадом */
  const activeSlots = new Set<number>();
  let layoutSig = '';
  let tickerFn: (() => void) | null = null;
  let onPointerDown: ((e: PointerEvent) => void) | null = null;
  let lastCanvasClearNonce = 0;
  let lastTickTime = performance.now();
  let emitAcc = 0;

  function rebuild() {
    const s = getSnap();
    const fontCss = s.fontCss;
    const tw = measureLineWidth(ctx, s.text, fontCss, s.letterSpacing);
    const ox = (s.w - tw) * 0.5;
    const oy = s.h * 0.55;
    const lays = layoutGlyphs(ctx, s.text, fontCss, s.fontSize, s.letterSpacing, ox, oy);
    roots = lays.map((g) => {
      const ink = inkMetrics(ctx, g.char, fontCss);
      return { char: g.char, x: g.x, y: g.baseline, ...ink };
    });
    activeSlots.clear();
    drops = [];
    emitAcc = 0;
  }

  function ensureLayout() {
    const s = getSnap();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.w}|${s.h}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      rebuild();
    }
  }

  function hitIndex(px: number, py: number): number {
    const pad = 2;
    for (let i = roots.length - 1; i >= 0; i--) {
      const r = roots[i]!;
      const left = r.x - r.abl - pad;
      const right = r.x + r.abr + pad;
      const top = r.y - r.aba - pad;
      const bottom = r.y + r.abd + pad;
      if (px >= left && px <= right && py >= top && py <= bottom) return i;
    }
    return -1;
  }

  function toggleWaterfall(slot: number) {
    if (activeSlots.has(slot)) {
      activeSlots.delete(slot);
      drops = drops.filter((d) => d.slot !== slot);
    } else {
      activeSlots.add(slot);
    }
  }

  function spawnDrop(slot: number) {
    const s = getSnap();
    const root = roots[slot];
    if (!root) return;
    const exp = s.visual.expansion;
    const spread = exp.spread * s.fontSize * 0.12;
    const ink = inkMetrics(ctx, root.char, s.fontCss);
    drops.push({
      char: root.char,
      slot,
      x: root.x + (Math.random() - 0.5) * spread,
      y: root.y - s.fontSize * (0.05 + Math.random() * 0.08),
      vx: (Math.random() - 0.5) * exp.sway * 12 + exp.wind * s.fontSize * 0.35,
      vy: exp.fallSpeed * (0.35 + Math.random() * 0.25),
      alpha: 0.35 + Math.random() * 0.45,
      ...ink,
      phase: Math.random() * Math.PI * 2,
    });
  }

  function tick() {
    const s = getSnap();
    const cn = s.visual.canvasClearNonce ?? 0;
    if (cn !== lastCanvasClearNonce) {
      lastCanvasClearNonce = cn;
      layoutSig = '';
    }
    ensureLayout();

    clearNeutral(ctx, s.w, s.h, s.visual.stageBackground);
    applyMultiplyBlend(ctx, s.visual.multiplyBlend);

    const frozen = s.visual.sceneFrozen;
    const exp = s.visual.expansion;
    const t = performance.now();
    const dt = Math.min(0.034, Math.max(0.008, (t - lastTickTime) / 1000));
    lastTickTime = t;

    if (!frozen) {
      const rate = 2 + exp.waterfallDensity * 28;
      emitAcc += dt * rate * activeSlots.size;
      while (emitAcc >= 1) {
        emitAcc -= 1;
        if (activeSlots.size === 0) break;
        const slots = [...activeSlots];
        const slot = slots[Math.floor(Math.random() * slots.length)]!;
        spawnDrop(slot);
      }

      const grav = s.fontSize * (1.8 + exp.fallSpeed * 4.5);
      const sway = exp.sway * s.fontSize * 0.35;
      const wind = exp.wind * s.fontSize * 2.8;

      for (const d of drops) {
        d.vy += grav * dt;
        d.vx += (wind + Math.sin(t * 0.0022 + d.phase) * sway) * dt;
        d.vx *= 1 - 1.8 * dt;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        d.alpha *= 1 - 0.15 * dt;
      }

      drops = drops.filter(
        (d) => d.y < s.h + s.fontSize && d.alpha > 0.06 && activeSlots.has(d.slot),
      );
    }

    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    for (const d of drops) {
      ctx.globalAlpha = d.alpha;
      ctx.fillStyle = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: d.slot,
        total: roots.length,
      });
      ctx.fillText(d.char, d.x, d.y);
    }

    for (let i = 0; i < roots.length; i++) {
      const r = roots[i]!;
      const active = activeSlots.has(i);
      ctx.globalAlpha = active ? 1 : 0.92;
      ctx.fillStyle = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: i,
        total: roots.length,
      });
      ctx.fillText(r.char, r.x, r.y);
    }
    ctx.restore();
  }

  return {
    start() {
      layoutSig = '';
      lastCanvasClearNonce = getSnap().visual.canvasClearNonce ?? 0;
      lastTickTime = performance.now();
      rebuild();
      tickerFn = () => tick();
      gsap.ticker.add(tickerFn);

      onPointerDown = (e: PointerEvent) => {
        if (getSnap().visual.sceneFrozen) return;
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const idx = hitIndex(px, py);
        if (idx >= 0) toggleWaterfall(idx);
      };

      canvas.addEventListener('pointerdown', onPointerDown);
    },
    stop() {
      if (tickerFn) gsap.ticker.remove(tickerFn);
      tickerFn = null;
      if (onPointerDown) canvas.removeEventListener('pointerdown', onPointerDown);
      onPointerDown = null;
    },
    dispose() {
      this.stop();
    },
    interruptInteraction() {},
  };
}
