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

/** Толщина «краски» AGOF — одна offset-копия за текстом. */
const OFFSET_RATIO = 0.22;
/** Перекрытие штампов следа (доля шага offset). */
const STAMP_OVERLAP = 0.38;
const MAX_STAMPS_PER_FRAME = 32;

export function createTrailWalkerMode(
  _canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let layoutSig = '';
  let tickerFn: (() => void) | null = null;
  let x = 0;
  let y = 0;
  let sampleX = 0;
  let sampleY = 0;
  let angle = 0;
  let turnT = 0;
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
    offsetDeltaPx = Math.max(2, layoutFontSize * OFFSET_RATIO);
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
    stamps = [];
  }

  function reset(s: ModeSnapshot) {
    rebuildLayout(s);
    rebuildOffsetShape(s);
    resetPosition();
  }

  function ensure(s: ModeSnapshot) {
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.lineHeight}|${s.w}|${s.h}|${s.fontUrl}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      reset(s);
      return;
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
    const worm = tw.worminess;

    if (s.visual.animationEnabled && !s.visual.sceneFrozen) {
      turnT += dt * (0.9 + worm * 2.8);
      angle += Math.sin(turnT * 1.35) * worm * 0.1 + Math.cos(turnT * 0.52) * worm * 0.07;
      x += Math.cos(angle) * speed;
      y += Math.sin(angle) * speed;

      const pad = s.fontSize;
      if (x < pad) {
        x = pad;
        angle = Math.PI - angle;
      }
      if (x > s.w - pad) {
        x = s.w - pad;
        angle = Math.PI - angle;
      }
      if (y < pad) {
        y = pad;
        angle = -angle;
      }
      if (y > s.h - pad) {
        y = s.h - pad;
        angle = -angle;
      }

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
        const p = stamps[i]!;
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
          trailAlpha = alpha * ((i + 1) / Math.max(1, stampN)) * 0.95;
        }

        drawOffsetAt(p.x, p.y, fill, trailAlpha);
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
      lastTick = performance.now();

      const snap = getSnap();
      reset(snap);
      layoutSig = `${snap.text}|${snap.fontCss}|${snap.fontSize}|${snap.letterSpacing}|${snap.lineHeight}|${snap.w}|${snap.h}|${snap.fontUrl}`;

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
