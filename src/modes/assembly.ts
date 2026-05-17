import gsap from 'gsap';
import { colorForGlyph, lerp, smoothstep } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import type { ModeController, ModeSnapshot } from './types';

type Slot = {
  char: string;
  tx: number;
  ty: number;
  w: number;
  h: number;
  /** текущая позиция (пружина к tx,ty) */
  x: number;
  y: number;
  vx: number;
  vy: number;
  merge: number;
  /** сглаженный микродрейф вокруг якоря */
  jx: number;
  jy: number;
  jxTgt: number;
  jyTgt: number;
  rot: number;
  vrot: number;
  orbitSeed: number;
  phaseA: number;
  phaseB: number;
  phaseC: number;
  driftAmp: number;
  driftFreq: number;
  ghostAngles: number[];
  ghostRadius: number[];
  gjx: number[];
  gjy: number[];
};

/** плавный шум из синусов — без резкого jitter */
function smoothDrift(t: number, phaseA: number, phaseB: number, phaseC: number, freq: number): { x: number; y: number } {
  const tt = t * 0.001 * freq;
  return {
    x:
      Math.sin(tt * 1.0 + phaseA) * 0.55 +
      Math.sin(tt * 0.37 + phaseB * 1.3) * 0.28 +
      Math.cos(tt * 0.21 + phaseC) * 0.17,
    y:
      Math.cos(tt * 0.92 + phaseB) * 0.52 +
      Math.sin(tt * 0.41 + phaseA * 0.8) * 0.3 +
      Math.cos(tt * 0.19 + phaseC * 1.1) * 0.18,
  };
}

export function createAssemblyMode(
  _canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let slots: Slot[] = [];
  let layoutSig = '';
  let tickerFn: (() => void) | null = null;
  let lastCanvasClearNonce = 0;
  let lastTickTime = performance.now();

  function rebuild() {
    const s = getSnap();
    const asm = s.visual.assembly;
    const spacingBoost = asm.overlap ? 0 : s.fontSize * 0.08;
    const letter = s.letterSpacing + spacingBoost;
    const tw = measureLineWidth(ctx, s.text, s.fontCss, letter);
    const baseOx = (s.w - tw) * 0.5;
    const oy = s.h * 0.55;
    const lays = layoutGlyphs(ctx, s.text, s.fontCss, s.fontSize, letter, baseOx, oy);
    const copies = Math.max(4, Math.min(28, Math.round(asm.inwardCopies)));
    const R0 = s.fontSize * asm.orbitRadius * 2.4;

    slots = lays.map((g) => {
      const angles: number[] = [];
      const radii: number[] = [];
      const gjx: number[] = [];
      const gjy: number[] = [];
      for (let k = 0; k < copies; k++) {
        angles.push((k / copies) * Math.PI * 2 + Math.random() * 0.5);
        radii.push((0.4 + Math.random() * 0.6) * R0);
        gjx.push((Math.random() - 0.5) * 4);
        gjy.push((Math.random() - 0.5) * 3);
      }
      const ang0 = Math.random() * Math.PI * 2;
      const r0 = R0 * (0.65 + Math.random() * 0.45);
      return {
        char: g.char,
        tx: g.x,
        ty: g.baseline,
        w: g.w,
        h: g.h,
        x: g.x + Math.cos(ang0) * r0,
        y: g.baseline + Math.sin(ang0) * r0 * 0.42,
        vx: (Math.random() - 0.5) * 8,
        vy: (Math.random() - 0.5) * 6,
        merge: 0,
        jx: 0,
        jy: 0,
        jxTgt: 0,
        jyTgt: 0,
        rot: (Math.random() - 0.5) * 0.08,
        vrot: 0,
        orbitSeed: Math.random() * Math.PI * 2,
        phaseA: Math.random() * Math.PI * 2,
        phaseB: Math.random() * Math.PI * 2,
        phaseC: Math.random() * 2000,
        driftAmp: 0.35 + Math.random() * 0.65,
        driftFreq: 0.55 + Math.random() * 0.85,
        ghostAngles: angles,
        ghostRadius: radii,
        gjx,
        gjy,
      };
    });
  }

  function ensure() {
    const s = getSnap();
    const asm = s.visual.assembly;
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.w}|${s.h}|${asm.overlap}|${asm.inwardCopies}|${asm.orbitRadius}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      rebuild();
    }
  }

  function tick() {
    const s = getSnap();
    const cn = s.visual.canvasClearNonce ?? 0;
    if (cn !== lastCanvasClearNonce) {
      lastCanvasClearNonce = cn;
      layoutSig = '';
    }
    ensure();

    clearNeutral(ctx, s.w, s.h, s.visual.stageBackground);
    applyMultiplyBlend(ctx, s.visual.multiplyBlend);

    const frozen = s.visual.sceneFrozen;
    const asm = s.visual.assembly;
    const anim = s.animationEnabled ? 1 : 0.5;
    const t = performance.now();
    const dt = Math.min(0.034, Math.max(0.008, (t - lastTickTime) / 1000));
    lastTickTime = t;

    const grid = Math.max(1, asm.pixelJump);
    const mergeSpd = asm.mergeSpeed * (anim ? 1.05 : 0.5);
    const driftPx = asm.drift * s.fontSize * 0.055 * anim;

    if (!frozen) {
      for (const sl of slots) {
        const dx = sl.tx - sl.x;
        const dy = sl.ty - sl.y;
        const dist = Math.hypot(dx, dy);

        const springK = (8 + mergeSpd * 42) * (1 + sl.merge * 0.15);
        const damp = 3.2 + mergeSpd * 8 + sl.merge * 2.5;
        sl.vx += (dx * springK - sl.vx * damp) * dt;
        sl.vy += (dy * springK - sl.vy * damp) * dt;
        sl.x += sl.vx * dt;
        sl.y += sl.vy * dt;

        const settle = 1 - smoothstep(s.fontSize * 0.35, s.fontSize * 0.08, dist);
        sl.merge += (settle - sl.merge) * (1 - Math.exp(-(2.5 + mergeSpd * 6) * dt));
        sl.merge = Math.max(0, Math.min(1, sl.merge));

        const rest = smoothstep(0.82, 1, sl.merge);
        const micro = driftPx * sl.driftAmp * (0.25 + rest * 0.75);
        const { x: nx, y: ny } = smoothDrift(t, sl.phaseA, sl.phaseB, sl.phaseC, sl.driftFreq);
        sl.jxTgt = nx * micro;
        sl.jyTgt = ny * micro;

        const glideK = 1 - Math.exp(-(3.5 + asm.drift * 4) * dt);
        sl.jx += (sl.jxTgt - sl.jx) * glideK;
        sl.jy += (sl.jyTgt - sl.jy) * glideK;

        if (grid > 1 && rest > 0.5) {
          sl.jx = lerp(sl.jx, Math.round(sl.jx / grid) * grid, 0.35);
          sl.jy = lerp(sl.jy, Math.round(sl.jy / grid) * grid, 0.35);
        }

        const rotMicro = (0.35 + rest * 0.65) * anim * 0.0012 * sl.driftAmp;
        sl.vrot += Math.sin(t * 0.001 + sl.phaseA) * rotMicro * dt;
        sl.vrot += (-sl.rot * (1.4 + asm.drift * 2) - sl.vrot * (2.2 + asm.drift)) * dt;
        sl.rot += sl.vrot * dt;
      }
    }

    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'alphabetic';
    const copies = slots[0]?.ghostAngles.length ?? 0;

    for (let i = 0; i < slots.length; i++) {
      const sl = slots[i]!;
      const me = sl.merge;
      const ease = 1 - Math.pow(1 - me, 2.2);
      const stagger = i * 0.018;
      const slotEase = Math.max(0, Math.min(1, (ease - stagger) / Math.max(0.1, 1 - stagger)));
      const ghostFade = 1 - smoothstep(0.55, 0.92, me);

      for (let k = 0; k < copies; k++) {
        if (ghostFade < 0.03) break;
        const ang = sl.ghostAngles[k]!;
        const R = sl.ghostRadius[k]! * ghostFade;
        const wob =
          s.fontSize *
          0.04 *
          ghostFade *
          Math.sin(t * 0.00105 + sl.orbitSeed + k * 1.6);
        const gx =
          sl.tx +
          Math.cos(ang + me * 1.05) * R +
          sl.gjx[k]! * ghostFade +
          wob;
        const gy =
          sl.ty +
          Math.sin(ang + me * 0.85) * R * 0.38 -
          R * 0.12 * ghostFade +
          sl.gjy[k]! * ghostFade +
          wob * 0.55;
        ctx.globalAlpha = (0.1 + 0.28 * ghostFade) * anim;
        ctx.fillStyle = colorForGlyph({
          mode: s.visual.colorMode,
          monochrome: s.visual.monochromeColor,
          seed: s.visual.rainbowSeed,
          index: i + k,
          total: slots.length + copies,
        });
        ctx.fillText(sl.char, gx, gy);
      }

      const drawX = sl.tx + sl.jx + (sl.x - sl.tx) * (1 - slotEase);
      const drawY = sl.ty + sl.jy + (sl.y - sl.ty) * (1 - slotEase);
      const qAlpha = 0.35 + 0.65 * slotEase;

      ctx.globalAlpha = qAlpha * anim;
      ctx.fillStyle = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: i,
        total: slots.length,
      });
      ctx.save();
      ctx.translate(drawX, drawY);
      ctx.rotate(sl.rot * slotEase);
      ctx.fillText(sl.char, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  return {
    start() {
      layoutSig = '';
      lastCanvasClearNonce = getSnap().visual.canvasClearNonce ?? 0;
      lastTickTime = performance.now();
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
