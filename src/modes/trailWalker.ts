import gsap from 'gsap';
import { colorForGlyph } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutTextForCanvas, measureLineWidth } from '../utils/textLayout';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

type TrailPt = { x: number; y: number; rot: number };

export function createTrailWalkerMode(
  _canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let layoutSig = '';
  let tickerFn: (() => void) | null = null;
  let x = 0;
  let y = 0;
  let angle = 0;
  let turnT = 0;
  let trail: TrailPt[] = [];
  let lastTick = performance.now();

  function reset(s: ModeSnapshot) {
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
    x = block.container.x + block.container.w * 0.5;
    y = block.container.y + block.container.h * 0.5;
    angle = Math.random() * Math.PI * 2;
    turnT = 0;
    trail = [{ x, y, rot: angle }];
  }

  function ensure(s: ModeSnapshot) {
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.lineHeight}|${s.w}|${s.h}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      reset(s);
    }
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
    const maxTrail = Math.max(4, Math.round(tw.trailLength));
    const speed = (40 + tw.speed * 220) * dt;
    const worm = tw.worminess;

    if (s.visual.animationEnabled && !s.visual.sceneFrozen) {
      turnT += dt * (1.2 + worm * 4);
      angle += Math.sin(turnT * 2.1) * worm * 0.12 + Math.cos(turnT * 0.7) * worm * 0.08;
      angle += (Math.random() - 0.5) * worm * 0.04;
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

      trail.push({ x, y, rot: angle });
      while (trail.length > maxTrail) trail.shift();
    }

    const text = s.text || ' ';
    const textW = measureLineWidth(ctx, text, s.fontCss, s.letterSpacing);
    const trailColor =
      s.visual.colorMode === 'rainbow'
        ? null
        : tw.trailColor || s.visual.monochromeColor;

    ctx.save();
    ctx.font = s.fontCss;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    for (let i = 0; i < trail.length; i++) {
      const p = trail[i]!;
      const t = (i + 1) / trail.length;
      ctx.globalAlpha = alpha * t * 0.95;
      ctx.fillStyle =
        trailColor ??
        colorForGlyph({
          mode: 'rainbow',
          monochrome: s.visual.monochromeColor,
          seed: s.visual.rainbowSeed,
          index: i,
          total: trail.length,
        });
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillText(text, -textW * 0.5, 0);
      ctx.restore();
    }

    const head = trail[trail.length - 1];
    if (head) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = colorForGlyph({
        mode: s.visual.colorMode,
        monochrome: s.visual.monochromeColor,
        seed: s.visual.rainbowSeed,
        index: 0,
        total: 1,
      });
      ctx.save();
      ctx.translate(head.x, head.y);
      ctx.rotate(head.rot);
      ctx.fillText(text, -textW * 0.5, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  return {
    start() {
      layoutSig = '';
      lastTick = performance.now();
      reset(getSnap());
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
