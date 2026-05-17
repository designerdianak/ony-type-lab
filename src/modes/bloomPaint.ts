import gsap from 'gsap';
import { colorForGlyph, hsla, lerp, randomVividPalette, smoothstep } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { safeReleasePointerCapture } from '../utils/pointerCapture';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import type { ModeController, ModeSnapshot } from './types';

/** Мягкое распухание с индивидуальным таймингом */
function easeOutBloom(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - u, 2.1);
}

/** 0 = ellipse, 1 = stretched ellipse, 2 = soft rect */
type BrushKind = 0 | 1 | 2;

type BrushParticle = {
  kind: BrushKind;
  ax: number;
  ay: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  tw: number;
  th: number;
  rot: number;
  rotVel: number;
  rotOffset: number;
  /** направление вращения при росте */
  growSpin: number;
  born: number;
  /** мс задержки роста — асинхронность */
  growDelay: number;
  /** множитель времени жизни */
  lifeScale: number;
  wobbleA: number;
  wobbleB: number;
  wobbleC: number;
  hueA: number;
  hueB: number;
  /** 0…1 — глубина слоя (прозрачность) */
  depth: number;
  aspect: number;
};

type Home = {
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
  melt: number;
  visAlpha: number;
  rot: number;
  vrot: number;
  /** уникальная фаза для микродвижения в покое */
  idlePhase: number;
};

export function createBloomPaintMode(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let particles: BrushParticle[] = [];
  let painting = false;
  let capturePointerId: number | null = null;
  let lastEmit = 0;
  let prevMouseX = 0;
  let prevMouseY = 0;
  let lastMouseX = 0;
  let lastMouseY = 0;
  let brushLagX = 0;
  let brushLagY = 0;
  let paletteHue = 0;
  let tickerFn: (() => void) | null = null;
  let homes: Home[] = [];
  let layoutSig = '';
  let lastClearNonce = 0;
  let lastTickTime = performance.now();

  function resetHomesLayout() {
    const s = getSnap();
    const tw = measureLineWidth(ctx, s.text, s.fontCss, s.letterSpacing);
    const ox = (s.w - tw) * 0.5;
    const oy = s.h * 0.55;
    const lays = layoutGlyphs(ctx, s.text, s.fontCss, s.fontSize, s.letterSpacing, ox, oy);
    homes = lays.map((g, i) => ({
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
      melt: 0,
      visAlpha: 1,
      rot: 0,
      vrot: 0,
      idlePhase: i * 1.7 + Math.random() * 2,
    }));
  }

  function ensureLayout() {
    const s = getSnap();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.w}|${s.h}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      resetHomesLayout();
    }
  }

  function syncCanvasClear() {
    const n = getSnap().visual.canvasClearNonce ?? 0;
    if (n !== lastClearNonce) {
      lastClearNonce = n;
      particles = [];
      for (const h of homes) {
        h.ox = h.oy = h.vx = h.vy = 0;
        h.melt = 0;
        h.visAlpha = 1;
        h.rot = 0;
        h.vrot = 0;
      }
      brushLagX = lastMouseX;
      brushLagY = lastMouseY;
    }
  }

  function particleCenter(sh: BrushParticle, t: number, b: ReturnType<typeof getSnap>['visual']['bloom']) {
    const swayT = (t + sh.wobbleC * 400) / Math.max(0.35, b.ovalSwayDuration);
    const plant = b.plantOrganic * b.motionIntensity;
    const driftX =
      Math.sin(swayT * 0.00048 + sh.wobbleA) * 9 * plant +
      Math.cos(swayT * 0.00031 + sh.wobbleB) * 4 * plant;
    const driftY =
      Math.sin(swayT * 0.00038 + sh.wobbleB) * 7 * plant +
      sh.vy * 0.08;
    return { sx: sh.ax + driftX, sy: sh.ay + driftY };
  }

  /** «Присутствие» фигуры: растёт с размером, падает при dissolve */
  function particlePresence(sh: BrushParticle, t: number, b: ReturnType<typeof getSnap>['visual']['bloom']) {
    const age = (t - sh.born) / 1000;
    const growAge = Math.max(0, t - sh.born - sh.growDelay) / 1000;
    const grow = easeOutBloom(Math.min(1, growAge * (0.72 + b.growSpeed * 0.38)));
    const fadeStart = 0.26 + (1 - b.graphicFade) * 0.48;
    const dissolve = Math.max(0, 1 - Math.max(0, age - fadeStart) * b.dissolveSpeed * 0.42);
    return dissolve * (0.08 + grow * 0.92);
  }

  function fieldPressure(px: number, py: number, t: number): number {
    const b = getSnap().visual.bloom;
    let p = 0;
    for (const sh of particles) {
      const presence = particlePresence(sh, t, b);
      if (presence < 0.02) continue;
      const { sx, sy } = particleCenter(sh, t, b);
      const reach = Math.max(40, 20 + (sh.w + sh.h) * 0.4);
      const d = Math.hypot(px - sx, py - sy);
      p += smoothstep(reach, 0, d) * presence * (0.65 + sh.depth * 0.35);
    }
    return Math.min(2.2, p);
  }

  function inkAtLetterHome(h: Home, t: number): number {
    const cx = h.x + h.w * 0.5;
    const cy = h.bl - h.h * 0.42;
    return Math.min(
      1.6,
      Math.max(
        fieldPressure(cx, cy, t),
        fieldPressure(cx - 8, cy, t),
        fieldPressure(cx + 8, cy, t),
        fieldPressure(cx, cy - 8, t),
        fieldPressure(cx, cy + 8, t),
      ),
    );
  }

  function glyphHitTight(mx: number, my: number, fontCss: string, h: Home, penX: number, penY: number): boolean {
    ctx.save();
    ctx.font = fontCss;
    ctx.textBaseline = 'alphabetic';
    const m = ctx.measureText(h.char);
    const abl = m.actualBoundingBoxLeft ?? 0;
    const abr = m.actualBoundingBoxRight ?? m.width;
    const aba = m.actualBoundingBoxAscent ?? h.h * 0.72;
    const abd = m.actualBoundingBoxDescent ?? h.h * 0.22;
    ctx.restore();
    return (
      mx >= penX - abl &&
      mx <= penX + abr &&
      my >= penY - aba &&
      my <= penY + abd
    );
  }

  function pickBrushKind(): BrushKind {
    const r = Math.random();
    if (r < 0.58) return 0;
    if (r < 0.88) return 1;
    return 2;
  }

  function spawnParticle(px: number, py: number, streamBias = 0) {
    const s = getSnap();
    const b = s.visual.bloom;
    const now = performance.now();
    const kind = pickBrushKind();
    const hues = randomVividPalette(s.visual.rainbowSeed + paletteHue * 0.01, 5);
    const pick = hues[Math.floor(Math.random() * hues.length)]!;
    const m = /hsla\(([\d.]+),/i.exec(pick);
    const ha = m ? Number(m[1]) : Math.random() * 360;
    paletteHue += 1;

    const scale = (0.82 + Math.random() * 0.42) * b.shapeSize;
    const aspect = kind === 1 ? 1.35 + Math.random() * 0.85 : 0.75 + Math.random() * 0.55;
    const tw = (8 + Math.random() * 16) * scale * (kind === 1 ? 1.15 : 1);
    const th = (26 + Math.random() * 52) * scale * aspect;

    const jx = (Math.random() - 0.5) * 14;
    const jy = (Math.random() - 0.5) * 11;

    particles.push({
      kind,
      ax: px + jx,
      ay: py + jy,
      vx: (Math.random() - 0.5) * 1.2 + streamBias * 0.4,
      vy: (Math.random() - 0.5) * 1.0 + streamBias * 0.25,
      w: 0.003,
      h: 0.003,
      tw,
      th,
      rot: (Math.random() - 0.5) * Math.PI,
      rotVel: (Math.random() - 0.5) * 0.0035,
      rotOffset: (Math.random() - 0.5) * 0.5,
      growSpin: Math.random() < 0.5 ? -1 : 1,
      born: now,
      growDelay: Math.random() * 140 + streamBias * 30,
      lifeScale: 0.82 + Math.random() * 0.45,
      wobbleA: Math.random() * Math.PI * 2,
      wobbleB: Math.random() * Math.PI * 2,
      wobbleC: Math.random() * 1000,
      hueA: ha,
      hueB: ha + 35 + Math.random() * 90,
      depth: 0.35 + Math.random() * 0.65,
      aspect,
    });
  }

  /** Непрерывный поток вдоль сегмента кисти */
  function emitStream(x0: number, y0: number, x1: number, y1: number, density: number) {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const step = lerp(14, 5, density);
    const n = Math.max(1, Math.ceil(dist / step));
    const dx = (x1 - x0) / n;
    const dy = (y1 - y0) / n;
    const streamBias = Math.min(1.8, dist * 0.04);
    for (let i = 0; i <= n; i++) {
      if (i > 0 && Math.random() > 0.35 + density * 0.55) continue;
      spawnParticle(x0 + dx * i, y0 + dy * i, streamBias);
      if (density > 0.5 && Math.random() < 0.22 + density * 0.28) {
        spawnParticle(
          x0 + dx * i + (Math.random() - 0.5) * 10,
          y0 + dy * i + (Math.random() - 0.5) * 8,
          streamBias * 0.6,
        );
      }
    }
  }

  function updateParticles(t: number, dt: number, frozen: boolean) {
    if (frozen) return;
    const b = getSnap().visual.bloom;
    const mot = b.motionIntensity;
    const brushVx = (lastMouseX - prevMouseX) / Math.max(dt, 0.001);
    const brushVy = (lastMouseY - prevMouseY) / Math.max(dt, 0.001);
    const flowMag = Math.min(1, Math.hypot(brushVx, brushVy) * 0.08);

    for (const sh of particles) {
      const idle = 0.35 + mot * 0.45;

      sh.vx +=
        (Math.sin(t * 0.00042 + sh.wobbleA) * 3.2 +
          Math.cos(t * 0.00029 + sh.wobbleB) * 2.1 +
          brushVx * 0.12 * (painting ? 1 : 0.15)) *
        idle *
        dt;
      sh.vy +=
        (Math.cos(t * 0.00036 + sh.wobbleB) * 2.8 +
          Math.sin(t * 0.00024 + sh.wobbleA) * 1.6 +
          brushVy * 0.12 * (painting ? 1 : 0.15)) *
        idle *
        dt;

      sh.vx *= 1 - (1.4 + flowMag * 0.8) * dt;
      sh.vy *= 1 - (1.4 + flowMag * 0.8) * dt;

      sh.ax += sh.vx * dt;
      sh.ay += sh.vy * dt;

      sh.rotVel += Math.sin(t * 0.0011 + sh.wobbleB) * 0.0014 * idle * dt;
      sh.rotVel *= 1 - 2.2 * dt;
      sh.rot += sh.rotVel * dt;

      const growAge = Math.max(0, t - sh.born - sh.growDelay) / 1000;
      const rawGrow = Math.min(1, growAge * (0.72 + b.growSpeed * 0.38));
      const grow = easeOutBloom(rawGrow);
      sh.w = lerp(0.003, sh.tw, grow);
      sh.h = lerp(0.003, sh.th, grow);

      if (grow < 0.98) {
        sh.rotVel += sh.growSpin * (0.0028 + grow * 0.0055) * (0.85 + mot * 0.35);
      }
    }
  }

  function drawParticle(sh: BrushParticle, t: number) {
    const s = getSnap();
    const b = s.visual.bloom;
    const age = (t - sh.born) / 1000;
    const fadeStart = 0.26 + (1 - b.graphicFade) * 0.48;
    const dissolve = Math.max(0, 1 - Math.max(0, age - fadeStart) * b.dissolveSpeed * 0.42);
    const { sx, sy } = particleCenter(sh, t, b);
    const growAge = Math.max(0, t - sh.born - sh.growDelay) / 1000;
    const rawGrow = Math.min(1, growAge * (0.72 + b.growSpeed * 0.38));
    const grow = easeOutBloom(rawGrow);
    const drawRot =
      sh.rot + sh.rotOffset + Math.sin(t * 0.00085 + sh.wobbleA) * 0.08 + grow * sh.growSpin * 0.12;

    const g = ctx.createLinearGradient(-sh.w, -sh.h, sh.w, sh.h);
    const midH = (sh.hueA + sh.hueB) * 0.5;
    const layerA = (0.72 + sh.depth * 0.22) * dissolve;
    g.addColorStop(0, hsla(sh.hueA, 96, 58, 0.88 * layerA));
    g.addColorStop(0.5, hsla(midH, 94, 52, 0.84 * layerA));
    g.addColorStop(1, hsla(sh.hueB, 92, 48, 0.8 * layerA));

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(drawRot);
    ctx.globalAlpha = (0.62 + sh.depth * 0.32) * Math.pow(dissolve, 0.82);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = g;
    ctx.beginPath();

    if (sh.kind === 0) {
      ctx.ellipse(0, 0, sh.w * 0.5, sh.h * 0.48, 0, 0, Math.PI * 2);
    } else if (sh.kind === 1) {
      const stretch = sh.aspect;
      ctx.ellipse(0, 0, sh.w * 0.52 * stretch, sh.h * 0.44, sh.rotOffset * 0.3, 0, Math.PI * 2);
    } else {
      const rw = sh.w * (0.92 + Math.sin(sh.wobbleA) * 0.06);
      const rh = sh.h * (0.9 + Math.cos(sh.wobbleB) * 0.05);
      const rr = Math.min(rw, rh) * 0.38;
      ctx.roundRect(-rw * 0.5, -rh * 0.5, rw, rh, rr);
    }

    ctx.fill();
    ctx.restore();
  }

  function updateLetters(t: number, dt: number, frozen: boolean) {
    if (frozen) return;
    const b = getSnap().visual.bloom;
    const fontCss = getSnap().fontCss;
    const ret = b.letterReturn;
    const mot = b.motionIntensity;
    const scatter = Math.max(0.15, b.letterScatter);
    const meltK = 1 - Math.exp(-(4 + mot * 3) * dt);
    const mx = lastMouseX;
    const my = lastMouseY;

    for (const h of homes) {
      const cx = h.x + h.w * 0.5;
      const cy = h.bl - h.h * 0.42;
      const onGlyph = painting && glyphHitTight(mx, my, fontCss, h, h.x, h.bl);

      const inkPr = inkAtLetterHome(h, t);
      const touchBoost = onGlyph ? 0.22 + fieldPressure(mx, my, t) * 0.35 : 0;
      const ink = Math.min(1.65, inkPr + touchBoost);

      const gpx =
        (fieldPressure(cx + 11, cy, t) - fieldPressure(cx - 11, cy, t)) * 0.5;
      const gpy =
        (fieldPressure(cx, cy + 11, t) - fieldPressure(cx, cy - 11, t)) * 0.5;

      const tgtMelt = Math.min(1, ink * 0.62 + smoothstep(0.12, 0.85, ink) * 0.38);
      h.melt += (tgtMelt - h.melt) * meltK;

      const alphaTarget = 1 - smoothstep(0.08, 0.38, ink);
      const alphaK =
        alphaTarget < h.visAlpha
          ? 1 - Math.exp(-(16 + mot * 12) * dt)
          : 1 - Math.exp(-(5 + ret * 10) * dt);
      h.visAlpha += (alphaTarget - h.visAlpha) * alphaK;

      const pushK = ink * scatter * (0.42 + h.melt * 0.35) * (0.35 + mot * 0.25);
      h.vx += gpx * pushK * 52 * dt;
      h.vy += gpy * pushK * 52 * dt;

      if (onGlyph) {
        const dx = cx - mx;
        const dy = cy - my;
        const d = Math.hypot(dx, dy) + 1;
        const repel = pushK * (1.1 + h.melt * 0.4);
        h.vx += (dx / d) * repel * 38 * dt;
        h.vy += (dy / d) * repel * 38 * dt;
      }

      const springK = (3.2 + ret * 11) * (1 - smoothstep(0, 0.5, ink) * 0.45);
      const damp = 3.8 + ret * 5 + h.melt * 2 + ink * 0.6;
      h.vx += (-h.ox * springK - h.vx * damp) * dt;
      h.vy += (-h.oy * springK - h.vy * damp) * dt;
      h.ox += h.vx * dt;
      h.oy += h.vy * dt;

      const idle = (1 - smoothstep(0, 0.2, ink)) * scatter * 0.28 * mot;
      h.vx += Math.sin(t * 0.00035 + h.idlePhase) * 1.8 * idle * dt;
      h.vy += Math.cos(t * 0.00031 + h.idlePhase * 1.3) * 1.5 * idle * dt;

      const tumble = scatter * (0.65 + mot * 0.22) * h.melt;
      h.vrot += (gpx * 0.5 + gpy * -0.18) * tumble * dt * 14;
      h.vrot += (-h.rot * (1.1 + ret * 2) - h.vrot * (1.8 + ret * 1.1)) * dt;
      h.rot += h.vrot * dt;
    }
  }

  function tick() {
    const s = getSnap();
    ensureLayout();
    syncCanvasClear();

    clearNeutral(ctx, s.w, s.h, s.visual.stageBackground);
    applyMultiplyBlend(ctx, false);

    const t = performance.now();
    const frozen = s.visual.sceneFrozen;
    const b = s.visual.bloom;
    const dt = Math.min(0.034, Math.max(0.008, (t - lastTickTime) / 1000));
    lastTickTime = t;

    if (!frozen) {
      const lifeMs = 5200 + b.graphicFade * 4200;
      particles = particles.filter((sh) => t - sh.born < lifeMs * sh.lifeScale);
    }

    const lagK = painting ? 1 - Math.exp(-(2.6 + b.motionIntensity * 3.5) * dt) : 1 - Math.exp(-1.2 * dt);
    brushLagX += (lastMouseX - brushLagX) * lagK;
    brushLagY += (lastMouseY - brushLagY) * lagK;

    updateParticles(t, dt, frozen);

    if (!frozen && painting) {
      const density = b.figureDensity;
      const segDx = lastMouseX - prevMouseX;
      const segDy = lastMouseY - prevMouseY;
      const segLen = Math.hypot(segDx, segDy);
      if (segLen > 1.5 || t - lastEmit > 28) {
        emitStream(prevMouseX, prevMouseY, lastMouseX, lastMouseY, density);
        lastEmit = t;
      }
    }

    prevMouseX = lastMouseX;
    prevMouseY = lastMouseY;

    ctx.save();
    if (b.blur) {
      const sb = b.shapeBlur ?? 0.78;
      ctx.filter = `blur(${4 + sb * 14}px)`;
    } else ctx.filter = 'none';

    const sorted = [...particles].sort((a, b) => a.depth - b.depth);
    for (const sh of sorted) drawParticle(sh, t);
    ctx.restore();

    updateLetters(t, dt, frozen);

    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'alphabetic';
    for (let i = 0; i < homes.length; i++) {
      const h = homes[i]!;
      const fill = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: i,
        total: homes.length,
      });
      ctx.globalAlpha = Math.max(0.08, Math.min(1, h.visAlpha));
      ctx.fillStyle = fill;
      const px = h.x + h.ox;
      const py = h.bl + h.oy;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(h.rot);
      ctx.fillText(h.char, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  function updateMouse(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    lastMouseX = e.clientX - r.left;
    lastMouseY = e.clientY - r.top;
  }

  function onPointerDown(e: PointerEvent) {
    if (getSnap().visual.sceneFrozen) return;
    painting = true;
    updateMouse(e);
    prevMouseX = lastMouseX;
    prevMouseY = lastMouseY;
    brushLagX = lastMouseX;
    brushLagY = lastMouseY;
    lastEmit = performance.now();
    emitStream(lastMouseX, lastMouseY, lastMouseX, lastMouseY, getSnap().visual.bloom.figureDensity);
    canvas.setPointerCapture(e.pointerId);
    capturePointerId = e.pointerId;
  }

  function onPointerMove(e: PointerEvent) {
    updateMouse(e);
  }

  function onPointerUp() {
    safeReleasePointerCapture(canvas, capturePointerId);
    capturePointerId = null;
    painting = false;
  }

  return {
    start() {
      layoutSig = '';
      resetHomesLayout();
      lastClearNonce = getSnap().visual.canvasClearNonce ?? 0;
      lastTickTime = performance.now();
      brushLagX = lastMouseX;
      brushLagY = lastMouseY;
      tickerFn = () => tick();
      gsap.ticker.add(tickerFn);
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
      painting = false;
      if (tickerFn) gsap.ticker.remove(tickerFn);
      tickerFn = null;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    },
    dispose() {
      this.stop();
    },
    interruptInteraction() {
      onPointerUp();
    },
  };
}
