import gsap from 'gsap';
import { colorForGlyph, lerp } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import type { ModeController, ModeSnapshot } from './types';

type Slot = {
  char: string;
  tx: number;
  ty: number;
  w: number;
  h: number;
  merge: number;
  ghostAngles: number[];
  ghostRadius: number[];
  /** Статичный пиксельный глитч на копию */
  gjx: number[];
  gjy: number[];
  jx: number;
  jy: number;
  orbitSeed: number;
};

export function createAssemblyMode(
  _canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let slots: Slot[] = [];
  let layoutSig = '';
  let tickerFn: (() => void) | null = null;
  let jumpAcc = 0;
  let lastCanvasClearNonce = 0;

  function rebuild() {
    const s = getSnap();
    const spacingBoost = s.visual.assembly.overlap ? 0 : s.fontSize * 0.08;
    const letter = s.letterSpacing + spacingBoost;
    const tw = measureLineWidth(ctx, s.text, s.fontCss, letter);
    const baseOx = (s.w - tw) * 0.5;
    const oy = s.h * 0.55;
    const lays = layoutGlyphs(ctx, s.text, s.fontCss, s.fontSize, letter, baseOx, oy);
    const copies = Math.max(4, Math.min(28, Math.round(s.visual.assembly.inwardCopies)));
    slots = lays.map((g) => {
      const angles: number[] = [];
      const radii: number[] = [];
      const gjx: number[] = [];
      const gjy: number[] = [];
      for (let k = 0; k < copies; k++) {
        angles.push((k / copies) * Math.PI * 2 + Math.random() * 0.4);
        radii.push((0.35 + Math.random() * 0.65) * s.fontSize * s.visual.assembly.orbitRadius * 2.2);
        gjx.push((Math.random() - 0.5) * 5);
        gjy.push((Math.random() - 0.5) * 4);
      }
      return {
        char: g.char,
        tx: g.x,
        ty: g.baseline,
        w: g.w,
        h: g.h,
        merge: 0,
        ghostAngles: angles,
        ghostRadius: radii,
        gjx,
        gjy,
        jx: 0,
        jy: 0,
        orbitSeed: Math.random() * Math.PI * 2,
      };
    });
  }

  function ensure() {
    const s = getSnap();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.w}|${s.h}|${s.visual.assembly.overlap}|${s.visual.assembly.inwardCopies}|${s.visual.assembly.orbitRadius}`;
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
    const spd = s.visual.assembly.mergeSpeed * (s.animationEnabled ? 1.1 : 0.55);
    const t = performance.now();
    if (!frozen) {
      for (const sl of slots) {
        sl.merge = Math.min(1, sl.merge + spd);
      }
    }

    const grid = Math.max(1, s.visual.assembly.pixelJump);
    const allMerged = slots.length > 0 && slots.every((sl) => sl.merge >= 0.98);
    if (!frozen && allMerged) {
      for (const sl of slots) {
        sl.jx = lerp(sl.jx, 0, 0.14);
        sl.jy = lerp(sl.jy, 0, 0.14);
      }
      if (s.animationEnabled) {
        jumpAcc += 1;
        if (jumpAcc > 14) {
          jumpAcc = 0;
          const drift = s.visual.assembly.drift * grid * 4;
          for (const sl of slots) {
            sl.jx = Math.round((Math.random() - 0.5) * drift / grid) * grid;
            sl.jy = Math.round((Math.random() - 0.5) * drift * 0.55 / grid) * grid;
          }
        }
      }
    } else if (!allMerged) {
      jumpAcc = 0;
    }

    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'alphabetic';
    const copies = slots[0]?.ghostAngles.length ?? 0;
    for (let i = 0; i < slots.length; i++) {
      const sl = slots[i]!;
      const ease = 1 - Math.pow(1 - sl.merge, 2.4);
      const stagger = i * 0.022;
      const me = Math.max(0, Math.min(1, (ease - stagger) / Math.max(0.12, 1 - stagger)));
      const microOrbit = s.fontSize * 0.06 * (1 - me * 0.35);
      for (let k = 0; k < copies; k++) {
        const ang = sl.ghostAngles[k]!;
        const R = sl.ghostRadius[k]! * (1 - me);
        const wobble =
          microOrbit * Math.sin(t * 0.0011 + sl.orbitSeed + k * 1.7 + sl.merge * 6);
        const wobbleY = microOrbit * 0.55 * Math.cos(t * 0.00095 + k * 1.1);
        const gx =
          sl.tx +
          Math.cos(ang + sl.merge * 1.1) * R +
          sl.gjx[k]! +
          wobble;
        const gy =
          sl.ty +
          Math.sin(ang + sl.merge * 0.9) * R * 0.38 -
          R * 0.15 * (1 - me) +
          sl.gjy[k]! +
          wobbleY;
        ctx.globalAlpha = 0.12 + 0.32 * (1 - me);
        ctx.fillStyle = colorForGlyph({
          mode: s.visual.colorMode,
          monochrome: s.visual.monochromeColor,
          seed: s.visual.rainbowSeed,
          index: i + k,
          total: slots.length + copies,
        });
        ctx.fillText(sl.char, gx, gy);
      }
      ctx.globalAlpha = 0.2 + 0.8 * me;
      ctx.fillStyle = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: i,
        total: slots.length,
      });
      const qx =
        sl.tx +
        sl.jx +
        Math.sin(t * 0.0013 + sl.orbitSeed) * s.fontSize * 0.04 * me;
      const qy =
        sl.ty +
        sl.jy +
        Math.cos(t * 0.0011 + sl.orbitSeed * 1.3) * s.fontSize * 0.035 * me;
      ctx.fillText(sl.char, qx, qy);
    }
    ctx.restore();
  }

  return {
    start() {
      layoutSig = '';
      lastCanvasClearNonce = getSnap().visual.canvasClearNonce ?? 0;
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
