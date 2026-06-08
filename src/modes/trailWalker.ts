import gsap from 'gsap';
import type opentype from 'opentype.js';
import { colorForGlyph } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { fillGlyphPath } from '../utils/opentypeCanvas';
import { layoutTextForCanvas, measureLineWidth } from '../utils/textLayout';
import {
  buildTextSilhouette,
  getVectorClipper,
  initVectorClipper,
  offsetPaths,
  pathsBoundsCenter,
  pathsToPath2D,
} from '../utils/vectorOffset';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

type TrailPt = { x: number; y: number };
type Lay = { char: string; x: number; bl: number };

/** Перекрытие штампов при равномерном шаге (доля шага offset). */
const STAMP_OVERLAP = 0.38;
const MAX_STAMPS_PER_FRAME = 32;

function offsetDeltaFromSetting(fontSize: number, thickness: number): number {
  const ratio = Math.max(0.04, Math.min(0.55, thickness));
  return Math.max(1.5, fontSize * ratio);
}

export function createTrailWalkerMode(
  _canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let layoutSig = '';
  let offsetSig = '';
  let tickerFn: (() => void) | null = null;
  let x = 0;
  let y = 0;
  let sampleX = 0;
  let sampleY = 0;
  let angle = 0;
  let turnT = 0;
  let jerkSegDist = 0;
  let jerkSegTarget = 60;
  let stamps: TrailPt[] = [];
  let lastTick = performance.now();

  let layoutFontSize = 72;
  let lays: Lay[] = [];
  let textCenter = { cx: 0, cy: 0 };
  let shapeAnchor = { cx: 0, cy: 0 };
  let offsetPath2D: Path2D | null = null;
  let offsetDeltaPx = 8;
  let clipperReady = false;

  function rebuildLayout(s: ModeSnapshot) {
    const block = layoutTextForCanvas(
      ctx,
      s.text,
      s.fontCss,
      s.fontSize,
      s.letterSpacing,
      s.w,
      s.h,
      s.lineHeight,
    );
    layoutFontSize = block.effectiveFontSize;
    lays = block.glyphs.map((g) => ({ char: g.char, x: g.x, bl: g.baseline }));
    textCenter = {
      cx: block.container.x + block.container.w * 0.5,
      cy: block.container.y + block.container.h * 0.5,
    };
  }

  function rebuildOffsetShape(s: ModeSnapshot) {
    offsetPath2D = null;
    const clipper = getVectorClipper();
    if (!clipper || !s.opentypeFont || lays.length === 0) return;

    const shape0 = buildTextSilhouette(clipper, s.opentypeFont, lays, layoutFontSize);
    if (!shape0.length) return;

    shapeAnchor = pathsBoundsCenter(shape0);
    offsetDeltaPx = offsetDeltaFromSetting(layoutFontSize, s.visual.trailWalker.offsetThickness);
    const offsetShape = offsetPaths(clipper, shape0, offsetDeltaPx);
    if (!offsetShape.length) return;

    offsetPath2D = pathsToPath2D(offsetShape);
  }

  function stampStep(): number {
    return Math.max(2.5, offsetDeltaPx * STAMP_OVERLAP);
  }

  function resetPosition() {
    const ax = offsetPath2D ? shapeAnchor.cx : textCenter.cx;
    const ay = offsetPath2D ? shapeAnchor.cy : textCenter.cy;
    x = ax;
    y = ay;
    sampleX = x;
    sampleY = y;
    angle = Math.random() * Math.PI * 2;
    turnT = 0;
    jerkSegDist = 0;
    jerkSegTarget = nextJerkSegmentTarget(1);
    stamps = [];
  }

  function reset(s: ModeSnapshot) {
    rebuildLayout(s);
    rebuildOffsetShape(s);
    resetPosition();
  }

  function ensure(s: ModeSnapshot) {
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.lineHeight}|${s.w}|${s.h}|${s.fontUrl}`;
    const offSig = `${sig}|${s.visual.trailWalker.offsetThickness}`;

    if (sig !== layoutSig) {
      layoutSig = sig;
      offsetSig = offSig;
      reset(s);
      return;
    }

    if (offSig !== offsetSig) {
      offsetSig = offSig;
      rebuildOffsetShape(s);
    }

    if (clipperReady && !offsetPath2D && s.opentypeFont && lays.length > 0) {
      rebuildOffsetShape(s);
      resetPosition();
    }
  }

  function pushStampsAlongPath(maxTrail: number) {
    const step = stampStep();
    let guard = 0;
    while (guard++ < MAX_STAMPS_PER_FRAME) {
      const dx = x - sampleX;
      const dy = y - sampleY;
      const dist = Math.hypot(dx, dy);
      if (dist < step) break;

      const ux = dx / dist;
      const uy = dy / dist;
      sampleX += ux * step;
      sampleY += uy * step;
      stamps.push({ x: sampleX, y: sampleY });
      while (stamps.length > maxTrail) stamps.shift();
    }
  }

  function nextJerkSegmentTarget(jerky: number): number {
    const min = 20;
    const max = 100;
    const len = min + Math.random() * (max - min);
    return len / Math.max(0.12, jerky);
  }

  function stampDrawPos(i: number, n: number, smear: boolean): { x: number; y: number } {
    const p = stamps[i]!;
    if (!smear || n < 2) return { x: p.x, y: p.y };

    const newer = stamps[i + 1] ?? { x, y };
    const dx = newer.x - p.x;
    const dy = newer.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;

    const age = 1 - (i + 1) / n;
    const spread = age * age * offsetDeltaPx * 2.8;

    return {
      x: p.x - ux * spread,
      y: p.y - uy * spread,
    };
  }

  function updateMotion(dt: number, worm: number, speed: number, pad: number, w: number, h: number) {
    const smooth = 1 - worm;
    const jerky = worm;

    turnT += dt * (1.2 + smooth * 2.8);
    angle +=
      (Math.sin(turnT * 2.1) * 0.12 + Math.cos(turnT * 0.7) * 0.08) * smooth;

    x += Math.cos(angle) * speed;
    y += Math.sin(angle) * speed;
    jerkSegDist += speed;

    if (jerky > 0.02 && jerkSegDist >= jerkSegTarget) {
      jerkSegDist = 0;
      jerkSegTarget = nextJerkSegmentTarget(jerky);
      const snap = Math.random() * Math.PI * 2;
      angle = jerky > 0.92 ? snap : angle * (1 - jerky) + snap * jerky;
    }

    if (x < pad) {
      x = pad;
      angle = Math.PI - angle;
    }
    if (x > w - pad) {
      x = w - pad;
      angle = Math.PI - angle;
    }
    if (y < pad) {
      y = pad;
      angle = -angle;
    }
    if (y > h - pad) {
      y = h - pad;
      angle = -angle;
    }
  }

  function drawOffsetAt(px: number, py: number, fill: string, alpha: number) {
    if (!offsetPath2D) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(px - shapeAnchor.cx, py - shapeAnchor.cy);
    ctx.fillStyle = fill;
    ctx.fill(offsetPath2D, 'evenodd');
    ctx.restore();
  }

  function drawGlyphsAt(
    px: number,
    py: number,
    fill: string,
    alpha: number,
    font: opentype.Font,
  ) {
    const dx = px - shapeAnchor.cx;
    const dy = py - shapeAnchor.cy;
    ctx.save();
    ctx.globalAlpha = alpha;
    for (const g of lays) {
      fillGlyphPath(ctx, font.getPath(g.char, g.x + dx, g.bl + dy, layoutFontSize), fill);
    }
    ctx.restore();
  }

  function drawFallbackTextAt(px: number, py: number, fill: string, alpha: number, s: ModeSnapshot) {
    const text = s.text || ' ';
    const textW = measureLineWidth(ctx, text, s.fontCss, s.letterSpacing);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = s.fontCss;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = fill;
    ctx.fillText(text, px - textW * 0.5, py);
    ctx.restore();
  }

  function tick() {
    const s = getSnap();
    ensure(s);
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastTick) / 1000);
    lastTick = now;

    clearNeutral(ctx, s.w, s.h, s.visual.stageBackground);
    applyMultiplyBlend(ctx, s.visual.multiplyBlend);

    const tw = s.visual.trailWalker;
    const alpha = effectOpacity(s.visual);
    const maxTrail =
      tw.trailMode === 'copies'
        ? Math.max(1, Math.round(tw.trailLength))
        : Math.max(4, Math.round(tw.trailLength));
    const speed = (40 + tw.speed * 220) * dt;
    const worm = Math.max(0, Math.min(1, tw.worminess));
    const smear = tw.stampSpacing === 'smear';

    if (s.visual.animationEnabled && !s.visual.sceneFrozen) {
      updateMotion(dt, worm, speed, s.fontSize, s.w, s.h);
      pushStampsAlongPath(maxTrail);
    }

    const trailColor =
      s.visual.colorMode === 'rainbow'
        ? null
        : tw.trailColor || s.visual.monochromeColor;
    const trailMode = tw.trailMode === 'copies' ? 'copies' : 'fade';
    const stampN = stamps.length;

    if (offsetPath2D) {
      for (let i = 0; i < stampN; i++) {
        const { x: sx, y: sy } = stampDrawPos(i, stampN, smear);
        const fill =
          trailColor ??
          colorForGlyph({
            mode: 'rainbow',
            monochrome: s.visual.monochromeColor,
            seed: s.visual.rainbowSeed,
            index: i,
            total: stampN,
          });

        let trailAlpha = alpha;
        if (trailMode === 'fade') {
          trailAlpha *= ((i + 1) / Math.max(1, stampN)) * 0.95;
        }

        drawOffsetAt(sx, sy, fill, trailAlpha);
      }

      const headFill =
        trailColor ??
        colorForGlyph({
          mode: 'rainbow',
          monochrome: s.visual.monochromeColor,
          seed: s.visual.rainbowSeed,
          index: stampN,
          total: stampN + 1,
        });
      drawOffsetAt(x, y, headFill, alpha);
    }

    if (s.opentypeFont) {
      const textFill = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: 0,
        total: 1,
      });
      drawGlyphsAt(x, y, textFill, alpha, s.opentypeFont);
    } else {
      const textFill = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: 0,
        total: 1,
      });
      drawFallbackTextAt(x, y, textFill, alpha, s);
    }
  }

  return {
    start() {
      clipperReady = false;
      offsetPath2D = null;
      offsetSig = '';
      lastTick = performance.now();

      const snap = getSnap();
      reset(snap);
      layoutSig = `${snap.text}|${snap.fontCss}|${snap.fontSize}|${snap.letterSpacing}|${snap.lineHeight}|${snap.w}|${snap.h}|${snap.fontUrl}`;
      offsetSig = `${layoutSig}|${snap.visual.trailWalker.offsetThickness}`;

      initVectorClipper()
        .then(() => {
          clipperReady = true;
          rebuildOffsetShape(getSnap());
          resetPosition();
        })
        .catch((err) => console.error('[Walk] clipper load failed', err));

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
