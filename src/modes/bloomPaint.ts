import gsap from 'gsap';
import { colorForGlyph, hsla, lerp, randomVividPalette, smoothstep } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { safeReleasePointerCapture } from '../utils/pointerCapture';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import type { ModeController, ModeSnapshot } from './types';

/** Мягкое «распухание» без рывка в начале и конце */
function easeOutBloom(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - u, 2.05);
}

type Shape = {
  kind: 0 | 1 | 2;
  ax: number;
  ay: number;
  /** текущие размеры (растут равномерно к tw/th) */
  w: number;
  h: number;
  tw: number;
  th: number;
  rot: number;
  born: number;
  sway: number;
  hueA: number;
  hueB: number;
  peak: number;
  stemPhase: number;
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
  jx: number;
  jy: number;
  jvx: number;
  jvy: number;
  /** Плавная видимость: падает пока рядом «чернила» графики, восстанавливается когда они ушли */
  visAlpha: number;
  /** Наклон при разлёте (рад), как в референсе */
  rot: number;
  vrot: number;
};

export function createBloomPaintMode(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let shapes: Shape[] = [];
  let painting = false;
  let capturePointerId: number | null = null;
  let lastPaint = 0;
  let prevMouseX = 0;
  let prevMouseY = 0;
  let lastMouseX = 0;
  let lastMouseY = 0;
  /** Лаг курсора — «память» движения кисти */
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
      melt: 0,
      jx: 0,
      jy: 0,
      jvx: 0,
      jvy: 0,
      visAlpha: 1,
      rot: 0,
      vrot: 0,
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
      shapes = [];
      for (const h of homes) {
        h.ox = h.oy = h.vx = h.vy = 0;
        h.melt = 0;
        h.jx = h.jy = h.jvx = h.jvy = 0;
        h.visAlpha = 1;
        h.rot = 0;
        h.vrot = 0;
      }
      brushLagX = lastMouseX;
      brushLagY = lastMouseY;
    }
  }

  /** Давление от фигур в точке (px, py) */
  function fieldPressure(px: number, py: number, t: number): number {
    const b = getSnap().visual.bloom;
    let p = 0;
    for (const sh of shapes) {
      const age = (t - sh.born) / 1000;
      const dissolve = Math.max(0, 1 - Math.max(0, age - 0.25) * 0.55);
      const swayT = t / Math.max(0.35, b.ovalSwayDuration);
      const plant = b.plantOrganic;
      const swayY = Math.sin(swayT * 0.0007 + sh.stemPhase) * 10 * plant;
      const sx = sh.ax + Math.sin(t * 0.0009 + sh.stemPhase) * 8;
      const sy = sh.ay + swayY * 0.35;
      const reach = Math.max(48, 26 + (sh.w + sh.h) * 0.38);
      const dx = px - sx;
      const dy = py - sy;
      const d = Math.hypot(dx, dy);
      p += smoothstep(reach, 0, d) * (0.2 + dissolve * 0.85);
    }
    return Math.min(2.2, p);
  }

  /** Попадание курсора в bbox глифа (measureText actualBoundingBox), в той же точке пера, что и fillText */
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
    const left = penX - abl;
    const right = penX + abr;
    const top = penY - aba;
    const bottom = penY + abd;
    return mx >= left && mx <= right && my >= top && my <= bottom;
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
    const peak = 0.55 + Math.random() * 0.35;
    const tw = (9 + Math.random() * 17) * b.shapeSize;
    const th = (30 + peak * 78) * b.shapeSize * (0.88 + Math.random() * 0.32);
    const jxa = (Math.random() - 0.5) * 12;
    const jya = (Math.random() - 0.5) * 9;
    paletteHue += 1;
    shapes.push({
      kind,
      ax: px + jxa,
      ay: py + jya,
      w: 0.004,
      h: 0.004,
      tw,
      th,
      rot: (Math.random() - 0.5) * 0.22,
      born: now,
      sway: Math.random() * Math.PI * 2,
      hueA: ha,
      hueB: ha + 40 + Math.random() * 80,
      peak,
      stemPhase: Math.random() * Math.PI * 2,
    });
  }

  /** Формы как раньше: эллипс / скруглённые столбы + растительное покачивание */
  function drawShape(sh: Shape, t: number) {
    const s = getSnap();
    const b = s.visual.bloom;
    const frozen = s.visual.sceneFrozen;
    const age = (t - sh.born) / 1000;
    const rawGrow = Math.min(1, age * (0.88 + b.growSpeed * 0.32));
    const grow = easeOutBloom(rawGrow);
    if (!frozen) {
      sh.w = lerp(0.004, sh.tw, grow);
      sh.h = lerp(0.004, sh.th, grow);
    }
    const fadeStart = 0.26 + (1 - b.graphicFade) * 0.48;
    const dissolve = Math.max(0, 1 - Math.max(0, age - fadeStart) * b.dissolveSpeed * 0.42);
    const swayT = t / Math.max(0.35, b.ovalSwayDuration);
    const plant = b.plantOrganic;
    const bend = Math.sin(swayT * 0.001 + sh.stemPhase) * 0.1 * plant;
    const swaySlow = Math.sin(swayT * 0.00052 + sh.sway) * 11 * plant * b.motionIntensity;
    const swayFast = Math.cos(swayT * 0.00165 + sh.sway * 1.3) * 4 * plant;
    if (!frozen) sh.rot += bend * 0.014 + swayFast * 0.00035;
    const swayX = swaySlow + swayFast;
    const swayY = Math.sin(swayT * 0.00065 + sh.stemPhase) * 8 * plant;

    const g = ctx.createLinearGradient(
      -sh.w * 1.05 - swayX * 0.12,
      -sh.h * 1.05 + swayY * 0.2,
      sh.w * 1.05 + swayX * 0.12,
      sh.h * 1.05 + swayY * 0.2,
    );
    const midH = (sh.hueA + sh.hueB) * 0.5;
    g.addColorStop(0, hsla(sh.hueA, 96, 55, 0.98 * dissolve));
    g.addColorStop(0.48, hsla(midH, 94, 50, 0.95 * dissolve));
    g.addColorStop(1, hsla(sh.hueB, 92, 45, 0.92 * dissolve));
    ctx.save();
    ctx.translate(sh.ax + swayX, sh.ay + swayY * 0.35);
    ctx.rotate(sh.rot);
    ctx.globalAlpha = 0.82 + 0.18 * Math.pow(dissolve, 0.75);
    const prevComp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = g;
    ctx.beginPath();
    if (sh.kind === 0) {
      ctx.ellipse(0, 0, sh.w * 0.52, sh.h * 0.48, bend * 0.35, 0, Math.PI * 2);
    } else if (sh.kind === 1) {
      const rw = sh.w;
      const rh = sh.h;
      const rr = Math.min(rw, rh) * 0.32;
      ctx.roundRect(-rw * 0.5, -rh * 0.5, rw, rh, rr);
    } else {
      const rw = sh.w * 1.06;
      const rh = sh.h * 0.9;
      const rr = Math.min(rw, rh) * 0.46;
      ctx.roundRect(-rw * 0.5, -rh * 0.5, rw, rh, rr);
    }
    ctx.fill();
    ctx.globalCompositeOperation = prevComp;
    ctx.restore();
  }

  function tick() {
    const s = getSnap();
    ensureLayout();
    syncCanvasClear();

    clearNeutral(ctx, s.w, s.h, s.visual.stageBackground);
    const mult = s.visual.multiplyBlend || s.visual.bloom.multiply;
    applyMultiplyBlend(ctx, mult);

    const t = performance.now();
    const frozen = s.visual.sceneFrozen;
    const b = s.visual.bloom;
    const dt = Math.min(0.034, Math.max(0.008, (t - lastTickTime) / 1000));
    lastTickTime = t;

    if (!frozen) {
      shapes = shapes.filter((sh) => t - sh.born < 5200 + b.graphicFade * 4000);
    }

    const lagK = painting ? 1 - Math.exp(-(2.8 + b.motionIntensity * 3.8) * dt) : 1 - Math.exp(-1.35 * dt);
    brushLagX += (lastMouseX - brushLagX) * lagK;
    brushLagY += (lastMouseY - brushLagY) * lagK;

    ctx.save();
    if (s.visual.bloom.blur) {
      const sb = s.visual.bloom.shapeBlur ?? 0.78;
      ctx.filter = `blur(${4 + sb * 14}px)`;
    } else ctx.filter = 'none';
    for (const sh of shapes) drawShape(sh, t);
    ctx.restore();

    const mot = b.motionIntensity;
    const meltFollow = 1 - Math.exp(-(3.6 + mot * 2.8) * dt);

    if (!frozen) {
      const fontCss = s.fontCss;
      const ret = b.letterReturn;
      for (const h of homes) {
        const cx = h.x + h.w * 0.5;
        const cy = h.bl - h.h * 0.42;
        /** Центр буквы с учётом разлёта — как в референсе сила и «чернила» идут от фактической позиции */
        const acx = cx + h.ox + h.jx;
        const acy = cy + h.oy + h.jy;
        const mx = lastMouseX;
        const my = lastMouseY;
        const colPadX = 14;
        const colPadY = 18;
        const inHomeColumn =
          painting &&
          mx >= h.x - colPadX &&
          mx <= h.x + h.w + colPadX &&
          my >= h.bl - h.h - colPadY &&
          my <= h.bl + colPadY * 0.48;
        const followR = 52 + h.h * 0.38 + h.melt * 48;
        const nearPaintedGlyph = painting && Math.hypot(mx - acx, my - acy) < followR;
        const inBand = inHomeColumn || nearPaintedGlyph;

        const penX = h.x + h.ox + h.jx;
        const penY = h.bl + h.oy + h.jy;
        const onGlyph = painting && glyphHitTight(mx, my, fontCss, h, penX, penY);

        let inkPr = 0;
        let gpx = 0;
        let gpy = 0;
        if (onGlyph) {
          inkPr = Math.min(1.35, 0.38 + fieldPressure(mx, my, t) * 1.05);
        } else if (inBand) {
          const core = Math.max(
            fieldPressure(acx, acy, t),
            fieldPressure(acx - 8, acy, t),
            fieldPressure(acx + 8, acy, t),
            fieldPressure(acx, acy - 8, t),
            fieldPressure(acx, acy + 8, t),
          );
          const atBrush = fieldPressure(mx, my, t);
          inkPr = Math.min(1.12, Math.max(core * 0.92, atBrush * 0.72));
        }

        if (inkPr > 0.03) {
          const sx = onGlyph ? mx : acx;
          const sy = onGlyph ? my : acy;
          gpx = (fieldPressure(sx + 10, sy, t) - fieldPressure(sx - 10, sy, t)) * 0.5;
          gpy = (fieldPressure(sx, sy + 10, t) - fieldPressure(sx, sy - 10, t)) * 0.5;
        }

        const distLag = Math.hypot(acx - brushLagX, acy - brushLagY);
        const brushPush = inkPr > 0.04 ? smoothstep(118, 0, distLag) * (onGlyph ? 1 : 0.62) : 0;

        const tgtMelt = Math.min(
          1,
          inkPr * 0.48 + brushPush * 0.26 + smoothstep(0.26, 1.02, inkPr) * 0.2,
        );
        h.melt += (tgtMelt - h.melt) * meltFollow;

        const alphaTarget = 1 - smoothstep(0, 0.24, inkPr);
        const alphaBase = 18 + mot * 12;
        const alphaK =
          alphaTarget > h.visAlpha
            ? 1 - Math.exp(-(alphaBase + ret * 32) * dt)
            : 1 - Math.exp(-(alphaBase + ret * 6) * dt);
        h.visAlpha += (alphaTarget - h.visAlpha) * alphaK;

        const scatter = Math.max(0.15, b.letterScatter);
        const flow = (0.55 + h.melt * 0.48 + inkPr * 0.38) * (0.16 + mot * 0.22) * scatter;
        const push = (0.065 + h.melt * 0.11) * scatter;
        const fx = gpx * flow * 34 + (acx - brushLagX) * brushPush * push * 0.85;
        const fy = gpy * flow * 34 + (acy - brushLagY) * brushPush * push * 0.85;
        h.vx += fx * dt * 16;
        h.vy += fy * dt * 16;

        /**
         * «Пылинка»: слабое тяготение к дому + сильное вязкое трение воздуха (без пружинного дребезга).
         * Нет отдельного k*x + (1-d)*v в стиле пружины — одна плавная релаксация скорости.
         */
        const inkEase = smoothstep(0.06, 0.5, inkPr);
        const relax = (0.42 + ret * 0.95) * (1 - inkEase * 0.72) * (1 - h.melt * 0.22);
        const drag = 1.85 + ret * 0.65 + inkPr * 0.45 + h.melt * 0.35;
        h.vx += (-h.ox * relax * 5.2 - h.vx * drag) * dt;
        h.vy += (-h.oy * relax * 5.2 - h.vy * drag) * dt;

        h.ox += h.vx * dt;
        h.oy += h.vy * dt;

        const dust =
          (1 - smoothstep(0, 0.24, inkPr)) * (1 - smoothstep(0.35, 0.95, h.melt)) * scatter;
        h.vx += Math.sin(t * 0.00038 + h.x * 0.052 + h.bl * 0.01) * 4.8 * dust * dt;
        h.vy += Math.cos(t * 0.00033 + h.bl * 0.041 + h.x * 0.013) * 4.0 * dust * dt;

        const jNoise = Math.sin(t * 0.0009 + h.x * 0.02) * 1.1 * h.melt;
        const jTx = gpx * 12 * h.melt + jNoise;
        const jTy = gpy * 12 * h.melt + Math.cos(t * 0.00075 + h.bl * 0.01) * 1.0 * h.melt;
        const jk = 0.032 + ret * 0.1;
        h.jvx += (jTx - h.jx) * jk;
        h.jvy += (jTy - h.jy) * jk;
        h.jx += h.jvx;
        h.jy += h.jvy;
        h.jvx *= 0.965 - h.melt * 0.025;
        h.jvy *= 0.965 - h.melt * 0.025;

        const tumble = scatter * (0.75 + mot * 0.28);
        h.vrot +=
          ((gpx * 0.48 + gpy * -0.2) * h.melt * 1.65 + inkPr * Math.sin(t * 0.0015 + h.x * 0.08) * 0.09) *
          tumble *
          dt *
          18;
        h.vrot += (-h.rot * (0.48 + ret * 0.95) - h.vrot * (0.88 + ret * 0.55)) * dt;
        h.rot += h.vrot * dt;
      }

      const speed = Math.hypot(lastMouseX - prevMouseX, lastMouseY - prevMouseY);
      prevMouseX = lastMouseX;
      prevMouseY = lastMouseY;
      const density = b.figureDensity;
      const baseGap = Math.round(lerp(78, 8, density));
      const speedBoost = Math.min(1, speed / 14);
      const spawnGap = Math.max(4, Math.round(baseGap * (1 - speedBoost * 0.75)));

      if (painting) {
        const dtPaint = t - lastPaint;
        if (dtPaint > spawnGap) {
          lastPaint = t;
          spawnShape(lastMouseX, lastMouseY);
          if (density > 0.48 && Math.random() < 0.28 + density * 0.38) {
            spawnShape(
              lastMouseX + (Math.random() - 0.5) * 20,
              lastMouseY + (Math.random() - 0.5) * 16,
            );
          }
        }
      }
    }

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
      ctx.globalAlpha = Math.max(0, Math.min(1, h.visAlpha));
      ctx.fillStyle = fill;
      const px = h.x + h.ox + h.jx;
      const py = h.bl + h.oy + h.jy;
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
    lastPaint = performance.now();
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
