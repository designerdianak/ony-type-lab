import gsap from 'gsap';
import { colorForGlyph, lerp, smoothstep } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import type { ModeController, ModeSnapshot } from './types';
import type { AssemblySettings } from '../types/playground';

type AsmGlyph = {
  char: string;
  slot: number;
  tx: number;
  ty: number;
  w: number;
  h: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  merge: number;
  lockTime: number;
  jx: number;
  jy: number;
  jxTgt: number;
  jyTgt: number;
  rot: number;
  vrot: number;
  phaseA: number;
  phaseB: number;
  glitchStep: number;
  speedMul: number;
  streamId: number;
};

export function createAssemblyMode(
  _canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let glyphs: AsmGlyph[] = [];
  let layoutSig = '';
  let tickerFn: (() => void) | null = null;
  let lastCanvasClearNonce = 0;
  let lastTickTime = performance.now();
  let fieldAngle = 0;
  let fieldAngleVel = 0;

  function flowVelocityAt(
    x: number,
    y: number,
    t: number,
    asm: AssemblySettings,
    w: number,
    h: number,
  ): { vx: number; vy: number } {
    const tt = t * 0.001 * (0.3 + asm.drift * 1.6);
    const curl = asm.orbitRadius * 1.1;
    const nx = (x / Math.max(1, w)) * Math.PI * 2;
    const ny = (y / Math.max(1, h)) * Math.PI * 2;
    const ang =
      fieldAngle +
      Math.sin(nx * 1.05 + ny * 0.62 + tt) * curl * 0.5 +
      Math.cos(nx * 0.72 - ny * 1.15 + tt * 0.7) * curl * 0.38;
    const base = 14 + asm.drift * 38 + asm.mergeSpeed * 18;
    const turb = 1 + Math.sin(t * 0.0005 + x * 0.007) * 0.1 * asm.orbitRadius;
    return { vx: Math.cos(ang) * base * turb, vy: Math.sin(ang) * base * turb * 0.58 };
  }

  function spawnGlyph(
    g: AsmGlyph,
    slot: number,
    lay: { char: string; x: number; baseline: number; w: number; h: number },
    margin: number,
    oy: number,
    rowH: number,
    fromLeft: boolean,
  ) {
    g.char = lay.char;
    g.slot = slot;
    g.tx = lay.x;
    g.ty = lay.baseline;
    g.w = lay.w;
    g.h = lay.h;
    g.merge = 0;
    g.lockTime = 0;
    g.jx = g.jy = g.jxTgt = g.jyTgt = 0;
    g.rot = (Math.random() - 0.5) * 0.1;
    g.vrot = 0;
    if (fromLeft) {
      g.x = -margin - Math.random() * 80;
      g.y = oy + (Math.random() - 0.5) * rowH * 0.9;
      g.vx = 20 + Math.random() * 30;
      g.vy = (Math.random() - 0.5) * 12;
    } else {
      g.x = lay.x + (Math.random() - 0.5) * 12;
      g.y = lay.baseline + (Math.random() - 0.5) * 8;
      g.vx = (Math.random() - 0.5) * 6;
      g.vy = (Math.random() - 0.5) * 6;
    }
  }

  function rebuild() {
    const s = getSnap();
    const asm = s.visual.assembly;
    const spacingBoost = asm.overlap ? 0 : s.fontSize * 0.06;
    const letter = s.letterSpacing + spacingBoost;
    const tw = measureLineWidth(ctx, s.text, s.fontCss, letter);
    const baseOx = (s.w - tw) * 0.5;
    const oy = s.h * 0.55;
    const lays = layoutGlyphs(ctx, s.text, s.fontCss, s.fontSize, letter, baseOx, oy);
    if (lays.length === 0) {
      glyphs = [];
      return;
    }

    const margin = 100;
    const avgW = Math.max(6, tw / lays.length);
    const span = s.w + margin * 2;
    const count = Math.ceil(span / (avgW * 0.68)) + lays.length * 3;
    const rowH = s.fontSize * 1.12;

    glyphs = [];
    for (let i = 0; i < count; i++) {
      const slot = i % lays.length;
      const lay = lays[slot]!;
      const g: AsmGlyph = {
        char: lay.char,
        slot,
        tx: lay.x,
        ty: lay.baseline,
        w: lay.w,
        h: lay.h,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        merge: 0,
        lockTime: 0,
        jx: 0,
        jy: 0,
        jxTgt: 0,
        jyTgt: 0,
        rot: 0,
        vrot: 0,
        phaseA: Math.random() * Math.PI * 2,
        phaseB: Math.random() * 2000,
        glitchStep: -1,
        speedMul: 0.76 + Math.random() * 0.48,
        streamId: i,
      };
      spawnGlyph(g, slot, lay, margin, oy, rowH, true);
      glyphs.push(g);
    }
  }

  function ensure() {
    const s = getSnap();
    const asm = s.visual.assembly;
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.w}|${s.h}|${asm.overlap}|${asm.drift}|${asm.orbitRadius}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      rebuild();
    }
  }

  function updateGlitch(g: AsmGlyph, t: number, asm: AssemblySettings, rest: number) {
    const grid = Math.max(1, asm.pixelJump);
    const stepMs = 95 + (1 - asm.mergeSpeed) * 85;
    const stepId = Math.floor(t / stepMs);
    if (stepId !== g.glitchStep && rest > 0.55) {
      g.glitchStep = stepId;
      const steps = [-1, 0, 1];
      g.jxTgt = steps[Math.floor(Math.random() * 3)]! * grid * (0.6 + Math.random() * 0.5);
      g.jyTgt = steps[Math.floor(Math.random() * 3)]! * grid * (0.6 + Math.random() * 0.45);
    }
    const snapK = rest > 0.7 ? 0.42 : 0.18;
    g.jx += (g.jxTgt - g.jx) * snapK;
    g.jy += (g.jyTgt - g.jy) * snapK;
    g.jx = lerp(g.jx, Math.round(g.jx / grid) * grid, rest * 0.55);
    g.jy = lerp(g.jy, Math.round(g.jy / grid) * grid, rest * 0.55);
    if (rest < 0.4) {
      g.jx *= 0.9;
      g.jy *= 0.9;
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
    const anim = s.animationEnabled ? 1 : 0.45;
    const t = performance.now();
    const dt = Math.min(0.034, Math.max(0.008, (t - lastTickTime) / 1000));
    lastTickTime = t;
    const margin = 100;
    const fs = s.fontSize;

    if (!frozen && glyphs.length > 0) {
      fieldAngleVel +=
        (Math.sin(t * 0.00026 + asm.drift) * 0.00032 * asm.orbitRadius - fieldAngleVel * 0.38) * dt;
      fieldAngle += fieldAngleVel * dt * 50 * (0.2 + asm.drift * 0.5) * anim;

      const followK = 1 - Math.exp(-(2 + asm.drift * 2.2) * dt);
      const pullK = 6 + asm.mergeSpeed * 48;

      for (const g of glyphs) {
        const dx = g.tx - g.x;
        const dy = g.ty - g.y;
        const dist = Math.hypot(dx, dy);
        const near = smoothstep(fs * 1.8, fs * 0.12, dist);

        const flow = flowVelocityAt(g.x, g.y, t, asm, s.w, s.h);
        const flowMix = (1 - g.merge) * (0.55 + asm.drift * 0.45);
        const tvx = flow.vx * g.speedMul * anim * flowMix;
        const tvy = flow.vy * g.speedMul * anim * flowMix;
        g.vx += (tvx - g.vx) * followK;
        g.vy += (tvy - g.vy) * followK;

        const pull = near * pullK * (0.35 + g.merge * 0.65);
        if (dist > 0.5) {
          g.vx += (dx / dist) * pull * dt;
          g.vy += (dy / dist) * pull * dt;
        }

        const damp = 2.4 + asm.mergeSpeed * 5 + g.merge * 2;
        g.vx *= 1 - damp * dt * 0.35;
        g.vy *= 1 - damp * dt * 0.35;
        g.x += g.vx * dt;
        g.y += g.vy * dt;

        if (g.x > s.w + margin) {
          g.x -= s.w + margin * 2;
        } else if (g.x < -margin) {
          g.x += s.w + margin * 2;
        }

        const tgtMerge = near * (0.4 + smoothstep(fs * 0.5, fs * 0.08, dist) * 0.6);
        g.merge += (tgtMerge - g.merge) * (1 - Math.exp(-(3 + asm.mergeSpeed * 8) * dt));
        g.merge = Math.max(0, Math.min(1, g.merge));

        const rest = smoothstep(0.72, 0.98, g.merge);
        updateGlitch(g, t, asm, rest);

        g.vrot += Math.sin(t * 0.001 + g.phaseA) * rest * 0.001 * dt;
        g.vrot += (-g.rot * 2 - g.vrot * 3) * dt;
        g.rot += g.vrot * dt;

        if (g.merge > 0.9 && dist < fs * 0.14) {
          g.lockTime += dt;
          const hold = 0.35 + (g.streamId % 7) * 0.04;
          if (g.lockTime > hold) {
            spawnGlyph(
              g,
              g.slot,
              { char: g.char, x: g.tx, baseline: g.ty, w: g.w, h: g.h },
              margin,
              s.h * 0.55,
              fs * 1.12,
              true,
            );
            g.glitchStep = -1;
          }
        } else {
          g.lockTime = 0;
        }
      }
    }

    const echoes = Math.max(2, Math.min(14, Math.round(asm.inwardCopies * 0.5)));

    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'alphabetic';

    for (const g of glyphs) {
      const me = g.merge;
      const fly = 1 - smoothstep(0.45, 0.88, me);
      if (fly < 0.04) continue;

      const spd = Math.hypot(g.vx, g.vy);
      const ex = spd > 0.5 ? -g.vx / spd : -1;
      const ey = spd > 0.5 ? -g.vy / spd : 0;
      const drawX = lerp(g.x, g.tx, smoothstep(0, 0.85, me));
      const drawY = lerp(g.y, g.ty, smoothstep(0, 0.85, me));

      for (let k = echoes; k >= 1; k--) {
        const trail = k / echoes;
        const lag = (5 + asm.orbitRadius * 8) * trail * fly;
        const tx = drawX + g.jx - ex * lag;
        const ty = drawY + g.jy - ey * lag;
        ctx.globalAlpha = fly * (0.05 + 0.16 * (1 - trail)) * anim;
        ctx.fillStyle = colorForGlyph({
          mode: s.visual.colorMode,
          monochrome: s.visual.monochromeColor,
          seed: s.visual.rainbowSeed,
          index: g.streamId + k,
          total: glyphs.length + echoes,
        });
        ctx.fillText(g.char, tx, ty);
      }
    }

    for (const g of glyphs) {
      const me = g.merge;
      const slotEase = smoothstep(0, 0.92, me);
      const drawX = g.tx + g.jx + (g.x - g.tx) * (1 - slotEase);
      const drawY = g.ty + g.jy + (g.y - g.ty) * (1 - slotEase);
      const alpha = (0.28 + 0.72 * slotEase) * anim;

      ctx.globalAlpha = alpha;
      ctx.fillStyle = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: g.slot,
        total: glyphs.length,
      });
      ctx.save();
      ctx.translate(drawX, drawY);
      ctx.rotate(g.rot * slotEase);
      ctx.fillText(g.char, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  return {
    start() {
      layoutSig = '';
      lastCanvasClearNonce = getSnap().visual.canvasClearNonce ?? 0;
      lastTickTime = performance.now();
      fieldAngle = Math.random() * Math.PI * 2;
      fieldAngleVel = 0;
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
