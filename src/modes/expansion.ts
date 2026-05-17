import gsap from 'gsap';
import { colorForGlyph, lerp } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import { separateDiscs } from '../utils/physics';
import { safeReleasePointerCapture } from '../utils/pointerCapture';
import type { ModeController, ModeSnapshot } from './types';

type Ent = {
  char: string;
  /** Как в layoutGlyphs: левый край глифа на базовой линии */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** actualBoundingBox* от пера (x,y), alphabetic — для хита и размера диска */
  abl: number;
  abr: number;
  aba: number;
  abd: number;
  r: number;
};

function inkMetricsFromPen(
  ctx: CanvasRenderingContext2D,
  char: string,
  fontCss: string,
  _penX: number,
  _penBaseline: number,
): { abl: number; abr: number; aba: number; abd: number; r: number } {
  ctx.save();
  ctx.font = fontCss;
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText(char);
  const abl = m.actualBoundingBoxLeft ?? 0;
  const abr = m.actualBoundingBoxRight ?? m.width;
  const aba = m.actualBoundingBoxAscent ?? m.fontBoundingBoxAscent ?? 0;
  const abd = m.actualBoundingBoxDescent ?? m.fontBoundingBoxDescent ?? 0;
  const iw = abl + abr;
  const ih = aba + abd;
  const r = Math.max(1.5, Math.hypot(iw * 0.5, ih * 0.5) * 0.4);
  ctx.restore();
  return { abl, abr, aba, abd, r };
}

function discCx(e: Ent): number {
  return e.x + (e.abr - e.abl) * 0.5;
}

function discCy(e: Ent): number {
  return e.y + (e.abd - e.aba) * 0.5;
}

function setPenFromDisc(e: Ent, cx: number, cy: number) {
  e.x = cx - (e.abr - e.abl) * 0.5;
  e.y = cy - (e.abd - e.aba) * 0.5;
}

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
  let strokeDragging = false;
  let capturePointerId: number | null = null;
  let lastStrokeIdx = -1;
  let onPointerDown: ((e: PointerEvent) => void) | null = null;
  let onPointerMove: ((e: PointerEvent) => void) | null = null;
  let onPointerUp: (() => void) | null = null;
  let autoTimer = 0;
  let lastCanvasClearNonce = 0;

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
      const ink = inkMetricsFromPen(ctx, g.char, fontCss, g.x, g.baseline);
      return {
        char: g.char,
        x: g.x,
        y: g.baseline,
        vx: 0,
        vy: 0,
        abl: ink.abl,
        abr: ink.abr,
        aba: ink.aba,
        abd: ink.abd,
        r: ink.r,
      };
    });
  }

  function hitIndex(px: number, py: number): number {
    const pad = 0.5;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i]!;
      const left = e.x - e.abl - pad;
      const right = e.x + e.abr + pad;
      const top = e.y - e.aba - pad;
      const bottom = e.y + e.abd + pad;
      if (px < left || px > right || py < top || py > bottom) continue;
      const cx = discCx(e);
      const cy = discCy(e);
      const d = Math.hypot(px - cx, py - cy);
      if (d < bestD) {
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
    const spawnPx = Math.max(1, s.visual.expansion.cloneSpawnDistance);
    for (let k = 0; k < amt; k++) {
      const ang = (k / Math.max(1, amt)) * Math.PI * 2 + Math.random() * 0.35;
      const dist = 0.15 + Math.random() * spawnPx;
      const ncx = discCx(base) + Math.cos(ang) * dist;
      const ncy = discCy(base) + Math.sin(ang) * dist;
      const burst = s.visual.expansion.spreadForce * (9 + Math.random() * 5);
      const clone: Ent = {
        char: base.char,
        x: 0,
        y: 0,
        vx: Math.cos(ang) * burst,
        vy: Math.sin(ang) * burst,
        abl: base.abl,
        abr: base.abr,
        aba: base.aba,
        abd: base.abd,
        r: base.r,
      };
      setPenFromDisc(clone, ncx, ncy);
      ents.push(clone);
    }
    const push = s.visual.expansion.spreadForce * 14;
    for (const e of ents) {
      const cx = discCx(e);
      const cy = discCy(e);
      const dx = cx - px;
      const dy = cy - py;
      const d = Math.hypot(dx, dy) + 0.01;
      e.vx += (dx / d) * push * 0.11;
      e.vy += (dy / d) * push * 0.11;
    }
  }

  function clientToCanvas(ev: PointerEvent): { px: number; py: number } {
    const rect = canvas.getBoundingClientRect();
    return { px: ev.clientX - rect.left, py: ev.clientY - rect.top };
  }

  function tick() {
    const s = getSnap();
    const cn = s.visual.canvasClearNonce ?? 0;
    if (cn !== lastCanvasClearNonce) {
      lastCanvasClearNonce = cn;
      lastText = '';
    }
    rebuildIfNeeded();
    clearNeutral(ctx, s.w, s.h, s.visual.stageBackground);
    applyMultiplyBlend(ctx, s.visual.multiplyBlend);

    const sets = s.visual.expansion;
    const n = ents.length;
    if (n === 0) return;

    const frozen = s.visual.sceneFrozen;

    const xs = new Float32Array(n);
    const ys = new Float32Array(n);
    const rs = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const e = ents[i]!;
      xs[i] = discCx(e);
      ys[i] = discCy(e);
      rs[i] = e.r;
    }
    const impulse = 0.22 + sets.collisionImpulse * 0.62;
    separateDiscs(xs, ys, rs, sets.collisionSpacing, 10);
    separateDiscs(xs, ys, rs, sets.collisionSpacing, 6);

    if (!frozen) {
      for (let i = 0; i < n; i++) {
        const e = ents[i]!;
        const cx = discCx(e);
        const cy = discCy(e);
        const ox = xs[i]! - cx;
        const oy = ys[i]! - cy;
        e.vx += ox * impulse;
        e.vy += oy * impulse;
      }

      for (let i = 0; i < n; i++) {
        const e = ents[i]!;
        const tx = xs[i]!;
        const ty = ys[i]!;
        let cx = discCx(e);
        let cy = discCy(e);
        e.vx = lerp(e.vx, (tx - cx) * sets.spreadForce * 0.32, 0.2);
        e.vy = lerp(e.vy, (ty - cy) * sets.spreadForce * 0.32, 0.2);
        cx += e.vx;
        cy += e.vy;
        setPenFromDisc(e, cx, cy);
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
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
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
      lastCanvasClearNonce = getSnap().visual.canvasClearNonce ?? 0;
      rebuildIfNeeded(true);
      tickerFn = () => tick();
      gsap.ticker.add(tickerFn);

      onPointerDown = (e: PointerEvent) => {
        if (getSnap().visual.sceneFrozen) return;
        strokeDragging = true;
        const { px, py } = clientToCanvas(e);
        const idx = hitIndex(px, py);
        lastStrokeIdx = idx;
        if (idx >= 0) cloneFrom(idx, px, py);
        canvas.setPointerCapture(e.pointerId);
        capturePointerId = e.pointerId;
      };

      onPointerMove = (e: PointerEvent) => {
        if (!strokeDragging || getSnap().visual.sceneFrozen) return;
        const { px, py } = clientToCanvas(e);
        const idx = hitIndex(px, py);
        if (idx >= 0 && idx !== lastStrokeIdx) {
          cloneFrom(idx, px, py);
          lastStrokeIdx = idx;
        } else if (idx < 0) {
          lastStrokeIdx = -1;
        }
      };

      onPointerUp = () => {
        safeReleasePointerCapture(canvas, capturePointerId);
        capturePointerId = null;
        strokeDragging = false;
        lastStrokeIdx = -1;
      };

      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerUp);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    },
    stop() {
      safeReleasePointerCapture(canvas, capturePointerId);
      capturePointerId = null;
      strokeDragging = false;
      lastStrokeIdx = -1;
      if (tickerFn) gsap.ticker.remove(tickerFn);
      tickerFn = null;
      if (onPointerDown) canvas.removeEventListener('pointerdown', onPointerDown);
      if (onPointerMove) canvas.removeEventListener('pointermove', onPointerMove);
      if (onPointerUp) {
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerUp);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
      }
      onPointerDown = onPointerMove = onPointerUp = null;
    },
    dispose() {
      this.stop();
    },
    interruptInteraction() {
      onPointerUp?.();
    },
  };
}
