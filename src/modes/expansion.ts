import gsap from 'gsap';
import type opentype from 'opentype.js';
import { DEFAULT_PLAYGROUND_VISUAL } from '../types/playground';
import { colorForGlyph } from '../utils/colors';
import { clearNeutral } from '../utils/canvas';
import { rasterizeGlyphMask } from '../utils/contourField';
import {
  drawRippleWave,
  expandShapeStep,
  extractMaskLoops,
  maskHasInk,
  type ContourChain,
  type ShapeStepParams,
} from '../utils/iterativeContours';
import { strokeGlyphPath } from '../utils/opentypeCanvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import { effectOpacity } from '../utils/visualAlpha';
import type { ModeController, ModeSnapshot } from './types';

type Lay = { char: string; x: number; bl: number };

type GlyphBuild = {
  chain: ContourChain;
  step: number;
  cur: Uint8Array;
  distBuf: Float32Array;
  offsetBuf: Uint8Array;
  smoothA: Uint8Array;
  smoothB: Uint8Array;
  ready: boolean;
};

const STEPS_PER_GLYPH = 3;
const BUILD_BUDGET_MS = 20;

function safeExpansion(s: ModeSnapshot) {
  return { ...DEFAULT_PLAYGROUND_VISUAL.expansion, ...s.visual.expansion };
}

function contourCount(exp: ReturnType<typeof safeExpansion>): number {
  const n = Math.round(exp.contourCount);
  if (!Number.isFinite(n) || n < 2) return 32;
  return Math.min(120, n);
}

/** ~1px сетка: контур повторяет форму буквы, как в референсе. */
function gridCell(ringSpacing: number, w: number, h: number) {
  const spacing = Math.max(2, ringSpacing);
  let cell = Math.max(0.65, Math.min(1.35, spacing / 4.2));
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  const maxCells = 500_000;
  if (cw * ch > maxCells) cell = Math.sqrt((w * h) / maxCells);
  return cell;
}

function shapeParams(exp: ReturnType<typeof safeExpansion>, cell: number): ShapeStepParams {
  const spacing = Math.max(2, exp.ringSpacing ?? 4);
  const count = contourCount(exp);
  const flatten = exp.waveFlatten ?? 0.5;
  const scale = Math.max(0.5, Math.min(2, exp.offsetScale ?? 1));
  return {
    radiusCells: Math.max(0.55, (spacing / cell) * scale),
    baseSmoothPasses: Math.round(1 + flatten * 2),
    baseThreshold: 0.44 - flatten * 0.1,
    waveFlatten: flatten,
    smoothFromStep: Math.max(8, Math.floor(count * 0.5)),
  };
}

function stageFill(stageBackground: string): string | null {
  return stageBackground === 'transparent' ? null : stageBackground;
}

export function createExpansionMode(
  _canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let lays: Lay[] = [];
  let layoutSig = '';
  let cacheSig = '';
  let tickerFn: (() => void) | null = null;

  let glyphBuilds: GlyphBuild[] = [];
  let allReady = false;
  let buildGen = 0;
  let buildingSig: string | null = null;
  let targetCount = 32;
  let buildParams: ShapeStepParams | null = null;

  let growPhase = 0;
  let growSig = '';
  const fillScratch = document.createElement('canvas');
  const segBuf: { x0: number; y0: number; x1: number; y1: number }[] = [];

  function viewport() {
    const s = getSnap();
    return { w: Math.max(1, Math.round(s.w)), h: Math.max(1, Math.round(s.h)) };
  }

  function rebuild() {
    const s = getSnap();
    const { w, h } = viewport();
    const text = s.text.trim();
    if (!text) {
      lays = [];
      return;
    }
    const tw = measureLineWidth(ctx, text, s.fontCss, s.letterSpacing);
    const ox = (w - tw) * 0.5;
    const oy = h * 0.55;
    const g = layoutGlyphs(ctx, text, s.fontCss, s.fontSize, s.letterSpacing, ox, oy);
    lays = g.map((lg) => ({ char: lg.char, x: lg.x, bl: lg.baseline }));
  }

  function initGlyphBuilds(s: ModeSnapshot, cell: number, count: number, params: ShapeStepParams) {
    const { w, h } = viewport();
    glyphBuilds = [];

    for (const lay of lays) {
      const raster = rasterizeGlyphMask(w, h, cell, [lay], s.fontCss, s.fontSize, s.opentypeFont);
      if (!maskHasInk(raster.mask)) continue;

      const mask0 = new Uint8Array(raster.mask);
      const chain: ContourChain = {
        masks: [mask0],
        loops: [extractMaskLoops(mask0, raster.cw, raster.ch, cell, segBuf)],
        cw: raster.cw,
        ch: raster.ch,
        cell,
      };

      glyphBuilds.push({
        chain,
        step: 1,
        cur: mask0,
        distBuf: new Float32Array(raster.mask.length),
        offsetBuf: new Uint8Array(raster.mask.length),
        smoothA: new Uint8Array(raster.mask.length),
        smoothB: new Uint8Array(raster.mask.length),
        ready: false,
      });
    }

    targetCount = count;
    buildParams = params;
    allReady = glyphBuilds.length === 0;
  }

  function scheduleChainBuild(s: ModeSnapshot) {
    const { w, h } = viewport();
    if (w < 32 || h < 32 || lays.length === 0) {
      glyphBuilds = [];
      allReady = false;
      buildingSig = null;
      return;
    }

    const exp = safeExpansion(s);
    const count = contourCount(exp);
    const cell = gridCell(exp.ringSpacing ?? 4, w, h);
    const params = shapeParams(exp, cell);

    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${w}|${h}|${cell}|${count}|${exp.ringSpacing}|${exp.offsetScale}|${exp.waveFlatten}`;
    if (sig === cacheSig && allReady) return;
    if (sig === buildingSig) return;

    cacheSig = sig;
    buildingSig = sig;
    allReady = false;
    buildGen++;
    const gen = buildGen;

    initGlyphBuilds(s, cell, count, params);
    if (allReady) {
      buildingSig = null;
      return;
    }

    const runBatch = () => {
      if (gen !== buildGen || !buildParams) return;

      try {
        const t0 = performance.now();

        for (const gb of glyphBuilds) {
          if (gb.ready) continue;

          let done = 0;
          while (
            gb.step < targetCount &&
            done < STEPS_PER_GLYPH &&
            performance.now() - t0 < BUILD_BUDGET_MS
          ) {
            gb.cur = expandShapeStep(
              gb.cur,
              gb.chain.cw,
              gb.chain.ch,
              gb.step,
              buildParams,
              gb.distBuf,
              gb.offsetBuf,
              gb.smoothA,
              gb.smoothB,
            );
            gb.chain.masks.push(new Uint8Array(gb.cur));
            gb.chain.loops.push(
              extractMaskLoops(gb.cur, gb.chain.cw, gb.chain.ch, gb.chain.cell, segBuf),
            );
            gb.step++;
            done++;
          }

          if (gb.step >= targetCount) gb.ready = true;
        }

        if (gen !== buildGen) return;

        if (glyphBuilds.every((g) => g.ready)) {
          allReady = true;
          buildingSig = null;
          return;
        }

        requestAnimationFrame(runBatch);
      } catch (err) {
        console.error('[Ripple] build step failed', err);
        buildingSig = null;
      }
    };

    requestAnimationFrame(runBatch);
  }

  function ensureLayout() {
    const s = getSnap();
    const { w, h } = viewport();
    const lay = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${w}|${h}`;
    if (lay !== layoutSig) {
      layoutSig = lay;
      cacheSig = '';
      rebuild();
    }
  }

  function strokeColor(s: ModeSnapshot, index: number) {
    const exp = safeExpansion(s);
    if (exp.strokeColor !== 'auto' && exp.strokeColor) return exp.strokeColor;
    return colorForGlyph({
      mode: s.visual.colorMode,
      monochrome: s.visual.monochromeColor,
      seed: s.visual.rainbowSeed,
      index,
      total: lays.length + 2,
    });
  }

  /** Shape0 — только контур буквы (как в референсе). */
  function drawTextStrokes(
    s: ModeSnapshot,
    col: string,
    lw: number,
    alpha: number,
    font: opentype.Font,
  ) {
    const fs = s.fontSize;
    ctx.save();
    ctx.globalAlpha = alpha;
    for (const g of lays) {
      strokeGlyphPath(ctx, font.getPath(g.char, g.x, g.bl, fs), col, lw);
    }
    ctx.restore();
  }

  function tick() {
    try {
      const s = getSnap();
      const { w, h } = viewport();
      if (w < 32 || h < 32) return;

      ensureLayout();
      scheduleChainBuild(s);
      clearNeutral(ctx, w, h, s.visual.stageBackground);

      if (glyphBuilds.length === 0 || lays.length === 0) return;

      const exp = safeExpansion(s);
      const alpha = effectOpacity(s.visual);
      const lw = Math.max(0.5, exp.strokeWidth ?? 1);
      const fill = stageFill(s.visual.stageBackground);
      const col = strokeColor(s, 0);
      const anim = s.animationEnabled && !s.visual.sceneFrozen;

      const maxBuiltWaves = Math.max(
        0,
        ...glyphBuilds.map((g) => g.chain.masks.length - 1),
      );

      const growKey = cacheSig;
      if (growKey !== growSig) {
        growSig = growKey;
        growPhase = 0;
      }
      if (anim && allReady) {
        growPhase = Math.min(maxBuiltWaves, growPhase + (exp.growSpeed ?? 0.45));
      } else if (!anim) {
        growPhase = maxBuiltWaves;
      }

      const visibleWaves =
        anim && allReady ? Math.min(maxBuiltWaves, Math.max(0, Math.floor(growPhase))) : maxBuiltWaves;

      ctx.save();
      ctx.globalCompositeOperation = 'source-over';

      for (let wave = 1; wave <= visibleWaves; wave++) {
        for (let gi = 0; gi < glyphBuilds.length; gi++) {
          const gb = glyphBuilds[gi]!;
          if (wave >= gb.chain.masks.length) continue;

          drawRippleWave(
            ctx,
            gb.chain.masks[wave]!,
            gb.chain.masks[wave - 1]!,
            gb.chain.loops[wave] ?? [],
            gb.chain.cw,
            gb.chain.ch,
            gb.chain.cell,
            fill,
            col,
            lw,
            alpha,
            fillScratch,
          );
        }
      }

      if (s.opentypeFont) {
        drawTextStrokes(s, col, lw, alpha, s.opentypeFont);
      }

      ctx.restore();
    } catch (err) {
      console.error('[Ripple] tick failed', err);
    }
  }

  return {
    start() {
      layoutSig = '';
      cacheSig = '';
      buildingSig = null;
      glyphBuilds = [];
      allReady = false;
      growPhase = 0;
      growSig = '';
      buildGen++;
      rebuild();
      scheduleChainBuild(getSnap());
      tickerFn = () => tick();
      gsap.ticker.add(tickerFn);
    },
    stop() {
      if (tickerFn) gsap.ticker.remove(tickerFn);
      tickerFn = null;
      buildGen++;
      buildingSig = null;
    },
    dispose() {
      this.stop();
    },
    interruptInteraction() {},
  };
}
