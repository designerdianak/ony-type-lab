import gsap from 'gsap';
import { colorForGlyph, lerp, smoothstep } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { effectOpacity } from '../utils/visualAlpha';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import type { ModeController, ModeSnapshot } from './types';
import type { SoftBodySettings } from '../types/playground';

type FlowGlyph = {
  char: string;
  w: number;
  h: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vrot: number;
  scale: number;
  phaseA: number;
  phaseB: number;
  phaseC: number;
  speedMul: number;
  streamIndex: number;
  jx: number;
  jy: number;
};

export function createSoftBodyMode(
  _canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let glyphs: FlowGlyph[] = [];
  let layoutSig = '';
  let tickerFn: (() => void) | null = null;
  let lastCanvasClearNonce = 0;
  let lastTickTime = performance.now();
  let fieldAngle = 0;
  let fieldAngleVel = 0;

  function flowAngleAt(x: number, y: number, t: number, cfg: SoftBodySettings, w: number, h: number): number {
    const tt = t * 0.001 * (0.35 + cfg.flowSpeed * 1.8);
    const curl = cfg.swirl * 1.15;
    const drift = cfg.drift * 2.4;
    const nx = (x / Math.max(1, w)) * Math.PI * 2;
    const ny = (y / Math.max(1, h)) * Math.PI * 2;
    return (
      fieldAngle +
      Math.sin(nx * 1.1 + ny * 0.65 + tt * 0.9 + drift) * curl * 0.55 +
      Math.cos(nx * 0.7 - ny * 1.2 + tt * 0.65) * curl * 0.42 +
      Math.sin((x + y) * 0.0035 + tt * 0.45 + cfg.drift) * curl * 0.35
    );
  }

  function flowVelocityAt(
    x: number,
    y: number,
    t: number,
    cfg: SoftBodySettings,
    w: number,
    h: number,
  ): { vx: number; vy: number } {
    const ang = flowAngleAt(x, y, t, cfg, w, h);
    const base = 18 + cfg.flowSpeed * 42 + cfg.drift * 22;
    const turb =
      1 +
      Math.sin(t * 0.00055 + x * 0.008 + y * 0.006) * 0.12 * cfg.swirl +
      Math.cos(t * 0.00042 + y * 0.01) * 0.08 * cfg.drift;
    return {
      vx: Math.cos(ang) * base * turb,
      vy: Math.sin(ang) * base * turb * 0.62,
    };
  }

  function wrapGlyph(g: FlowGlyph, w: number, h: number, margin: number) {
    const spanX = w + margin * 2;
    const spanY = h + margin * 2;
    if (g.x > w + margin) g.x -= spanX;
    else if (g.x < -margin) g.x += spanX;
    if (g.y > h + margin) g.y -= spanY;
    else if (g.y < -margin) g.y += spanY;
  }

  function edgeAlpha(x: number, y: number, w: number, h: number): number {
    const fx = smoothstep(0, 72, x) * smoothstep(0, 72, w - x);
    const fy = smoothstep(0, 56, y) * smoothstep(0, 56, h - y);
    return Math.sqrt(fx * fy);
  }

  function rebuild() {
    const s = getSnap();
    const cfg = s.visual.softBody;
    const spacingBoost = cfg.overlap ? 0 : s.fontSize * 0.06;
    const letter = s.letterSpacing + spacingBoost;
    const tw = measureLineWidth(ctx, s.text, s.fontCss, letter);
    const baseOx = (s.w - tw) * 0.5;
    const oy = s.h * 0.55;
    const lays = layoutGlyphs(ctx, s.text, s.fontCss, s.fontSize, letter, baseOx, oy);
    if (lays.length === 0) {
      glyphs = [];
      return;
    }

    const avgW = Math.max(6, tw / lays.length);
    const margin = 90;
    const span = s.w + margin * 2;
    const maxStream = Math.ceil(span / (avgW * 0.72)) + lays.length + 4;
    const vortexMax = 16;
    const vortex = Math.max(1, Math.min(vortexMax, Math.round(cfg.vortexCopies)));
    const fillT = vortexMax <= 1 ? 1 : (vortex - 1) / (vortexMax - 1);
    const count = Math.max(lays.length, Math.round(lerp(lays.length, maxStream, fillT)));

    const mkGlyph = (src: (typeof lays)[0], x: number, y: number, streamIndex: number): FlowGlyph => ({
      char: src.char,
      w: src.w,
      h: src.h,
      x,
      y,
      vx: 0,
      vy: 0,
      rot: (Math.random() - 0.5) * 0.12,
      vrot: (Math.random() - 0.5) * 0.0015,
      scale: 0.96 + Math.random() * 0.08,
      phaseA: Math.random() * Math.PI * 2,
      phaseB: Math.random() * Math.PI * 2,
      phaseC: Math.random() * 2000,
      speedMul: 0.78 + Math.random() * 0.44,
      streamIndex,
      jx: 0,
      jy: 0,
    });

    glyphs = [];

    if (vortex <= 1) {
      for (let i = 0; i < lays.length; i++) {
        const g = lays[i]!;
        glyphs.push(mkGlyph(g, g.x, g.baseline, i));
      }
      return;
    }

    let cursorX = -margin + Math.random() * avgW;
    const rowH = s.fontSize * 1.15;

    for (let i = 0; i < count; i++) {
      const src = lays[i % lays.length]!;
      const lane = (i % 3) - 1;
      glyphs.push(
        mkGlyph(
          src,
          cursorX,
          oy + lane * rowH * 0.22 + (Math.random() - 0.5) * rowH * 0.35,
          i,
        ),
      );
      cursorX += src.w + letter + avgW * 0.08;
      if (cursorX > s.w + margin) {
        cursorX = -margin + (Math.random() - 0.5) * 40;
      }
    }
  }

  function ensure() {
    const s = getSnap();
    const cfg = s.visual.softBody;
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.w}|${s.h}|${cfg.overlap}|${cfg.vortexCopies}|${cfg.flowSpeed}|${cfg.drift}|${cfg.swirl}`;
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
    const cfg = s.visual.softBody;
    const anim = s.animationEnabled ? 1 : 0.42;
    const t = performance.now();
    const dt = Math.min(0.034, Math.max(0.008, (t - lastTickTime) / 1000));
    lastTickTime = t;

    const margin = 90;

    if (!frozen && glyphs.length > 0) {
      const globalDrift = (0.25 + cfg.drift * 0.55) * anim;
      fieldAngleVel +=
        (Math.sin(t * 0.00028 + cfg.drift) * 0.00035 * cfg.swirl - fieldAngleVel * 0.4) * dt;
      fieldAngle += fieldAngleVel * dt * 60 * globalDrift;

      const followK = 1 - Math.exp(-(2.2 + cfg.flowSpeed * 2.5) * dt);
      const grid = Math.max(1, cfg.pixelJump);

      for (const g of glyphs) {
        const { vx: tvx, vy: tvy } = flowVelocityAt(g.x, g.y, t, cfg, s.w, s.h);
        const tgtVx = tvx * g.speedMul * anim;
        const tgtVy = tvy * g.speedMul * anim;

        g.vx += (tgtVx - g.vx) * followK;
        g.vy += (tgtVy - g.vy) * followK;

        const micro = (0.35 + cfg.swirl * 0.25) * anim;
        g.vx += Math.sin(t * 0.00038 + g.phaseA) * 2.8 * micro * dt;
        g.vy += Math.cos(t * 0.00033 + g.phaseB) * 2.2 * micro * dt;

        g.x += g.vx * dt;
        g.y += g.vy * dt;

        wrapGlyph(g, s.w, s.h, margin);

        let jx = Math.sin(t * 0.0009 + g.phaseB) * s.fontSize * 0.018 * micro;
        let jy = Math.cos(t * 0.00075 + g.phaseA) * s.fontSize * 0.014 * micro;
        if (grid > 1) {
          jx = Math.round(jx / grid) * grid;
          jy = Math.round(jy / grid) * grid;
        }
        g.rot += g.vrot * dt;
        g.vrot += (Math.sin(t * 0.001 + g.phaseA) * 0.0018 * micro - g.vrot * 1.6) * dt;
        g.scale += (1 + Math.sin(t * 0.00065 + g.phaseC) * 0.028 * micro - g.scale) * (1 - Math.exp(-4 * dt));

        g.jx = jx;
        g.jy = jy;
      }
    }

    const echoes = Math.max(2, Math.min(12, Math.round(cfg.trailDepth * 0.45)));
    const master = effectOpacity(s.visual);

    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'alphabetic';

    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i]!;
      const ea = edgeAlpha(g.x, g.y, s.w, s.h);
      if (ea < 0.02) continue;

      const spd = Math.hypot(g.vx, g.vy);
      const ex = -g.vx / Math.max(1, spd);
      const ey = -g.vy / Math.max(1, spd);

      for (let k = echoes; k >= 1; k--) {
        const trail = k / echoes;
        const lag = (6 + cfg.swirl * 10) * trail;
        const tx = g.x + g.jx - ex * lag;
        const ty = g.y + g.jy - ey * lag;
        const trailRot = g.rot - g.vrot * trail * 0.4;
        const trailScale = g.scale * (1 - trail * 0.04);

        ctx.save();
        ctx.translate(tx, ty);
        ctx.rotate(trailRot);
        ctx.scale(trailScale, trailScale);
        ctx.globalAlpha = ea * (0.04 + 0.14 * (1 - trail)) * anim * master;
        ctx.fillStyle = colorForGlyph({
          mode: s.visual.colorMode,
          monochrome: s.visual.monochromeColor,
          seed: s.visual.rainbowSeed,
          index: g.streamIndex + k,
          total: glyphs.length + echoes,
        });
        ctx.fillText(g.char, 0, 0);
        ctx.restore();
      }

      ctx.save();
      ctx.translate(g.x + g.jx, g.y + g.jy);
      ctx.rotate(g.rot);
      ctx.scale(g.scale, g.scale);
      ctx.globalAlpha = ea * (0.55 + 0.45 * anim) * master;
      ctx.fillStyle = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: g.streamIndex,
        total: glyphs.length,
      });
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
