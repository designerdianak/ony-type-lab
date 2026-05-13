import gsap from 'gsap';
import { colorForGlyph, lerp } from '../utils/colors';
import { applyMultiplyBlend, clearNeutral } from '../utils/canvas';
import { layoutGlyphs, measureLineWidth } from '../utils/textLayout';
import type { ModeController, ModeSnapshot } from './types';

/**
 * Ломаная «резиновая» линия: якоря под каждой буквой (низ по центру),
 * пружина между соседями, перетаскивание ломает линию; копии тянущейся
 * буквы заполняют сегменты — в духе noomalooma / counter-archiving.
 */
export function createElasticLineMode(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  let chars: string[] = [];
  let widths: number[] = [];
  /** Нижний центр глифа (для baseline + поворота) */
  let bx: number[] = [];
  let by: number[] = [];
  let initBx: number[] = [];
  let initBy: number[] = [];
  let layoutSig = '';
  let dragIdx = -1;
  let grabOx = 0;
  let grabOy = 0;
  let tickerFn: (() => void) | null = null;
  let down: ((e: PointerEvent) => void) | null = null;
  let move: ((e: PointerEvent) => void) | null = null;
  let up: (() => void) | null = null;

  function rebuild() {
    const s = getSnap();
    const tw = measureLineWidth(ctx, s.text, s.fontCss, s.letterSpacing);
    const ox = (s.w - tw) * 0.5;
    const oy = s.h * 0.55;
    const lays = layoutGlyphs(ctx, s.text, s.fontCss, s.fontSize, s.letterSpacing, ox, oy);
    chars = lays.map((g) => g.char);
    widths = lays.map((g) => g.w);
    const bl = lays[0]?.baseline ?? oy;
    bx = lays.map((g) => g.x + g.w * 0.5);
    by = lays.map(() => bl);
    initBx = bx.slice();
    initBy = by.slice();
    dragIdx = -1;
  }

  function ensure() {
    const s = getSnap();
    const sig = `${s.text}|${s.fontCss}|${s.fontSize}|${s.letterSpacing}|${s.w}|${s.h}`;
    if (sig !== layoutSig) {
      layoutSig = sig;
      rebuild();
    }
  }

  function hit(px: number, py: number): number {
    const s = getSnap();
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < bx.length; i++) {
      const d = Math.hypot(px - bx[i]!, py - by[i]!);
      const rad = Math.max(widths[i] ?? 10, s.fontSize * 0.45) * 0.55;
      if (d < rad && d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  function relaxRope() {
    const s = getSnap();
    const n = bx.length;
    if (n < 3) return;
    const k = 0.14 * (s.animationEnabled ? 1 : 0.65);
    const home = 0.012;
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 1; i < n - 1; i++) {
        if (i === dragIdx) continue;
        const tx = (bx[i - 1]! + bx[i + 1]!) * 0.5;
        const ty = (by[i - 1]! + by[i + 1]!) * 0.5;
        bx[i] = lerp(bx[i]!, tx, k);
        by[i] = lerp(by[i]!, ty, k);
        bx[i] = lerp(bx[i]!, initBx[i]!, home);
        by[i] = lerp(by[i]!, initBy[i]!, home);
      }
    }
  }

  function segmentAngle(x0: number, y0: number, x1: number, y1: number): number {
    return Math.atan2(y1 - y0, x1 - x0);
  }

  function sampleSegment(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    spacing: number,
    out: { x: number; y: number; ang: number; ch: string }[],
    ch: string,
  ) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < spacing * 1.2) return;
    const ang = Math.atan2(y1 - y0, x1 - x0);
    let t = spacing * 0.55;
    while (t < len - spacing * 0.45) {
      const u = t / len;
      out.push({
        x: x0 + (x1 - x0) * u,
        y: y0 + (y1 - y0) * u,
        ang,
        ch,
      });
      t += spacing;
    }
  }

  function gapFills(dr: number): { x: number; y: number; ang: number; ch: string; a: number }[] {
    const s = getSnap();
    if (dr < 0 || dr >= chars.length) return [];
    const ch = chars[dr]!;
    const sp = Math.max(6, (widths[dr] ?? s.fontSize * 0.5) * s.visual.elastic.fillSpacing);
    const out: { x: number; y: number; ang: number; ch: string; a: number }[] = [];
    if (dr > 0) {
      sampleSegment(bx[dr - 1]!, by[dr - 1]!, bx[dr]!, by[dr]!, sp, out, ch);
    }
    if (dr < chars.length - 1) {
      sampleSegment(bx[dr]!, by[dr]!, bx[dr + 1]!, by[dr + 1]!, sp, out, ch);
    }
    for (const o of out) o.a = 0.22;
    return out;
  }

  /** Копии вдоль любых растянутых сегментов — остаются после отпускания */
  function stretchGapFills(): { x: number; y: number; ang: number; ch: string; a: number }[] {
    const s = getSnap();
    const out: { x: number; y: number; ang: number; ch: string; a: number }[] = [];
    for (let i = 0; i < chars.length - 1; i++) {
      const x0 = bx[i]!;
      const y0 = by[i]!;
      const x1 = bx[i + 1]!;
      const y1 = by[i + 1]!;
      const rest = Math.hypot(initBx[i + 1]! - initBx[i]!, initBy[i + 1]! - initBy[i]!);
      const curr = Math.hypot(x1 - x0, y1 - y0);
      if (curr <= rest * 1.04) continue;
      const ch = chars[i + 1] ?? chars[i]!;
      const sp = Math.max(6, (widths[i + 1] ?? widths[i] ?? s.fontSize * 0.5) * s.visual.elastic.fillSpacing);
      sampleSegment(x0, y0, x1, y1, sp, out, ch);
    }
    const alpha = dragIdx >= 0 ? 0.2 : 0.34;
    for (const o of out) o.a = alpha;
    return out;
  }

  function drawLetterAt(
    ch: string,
    x: number,
    y: number,
    ang: number,
    alpha: number,
    fill: string,
    fontCss: string,
  ) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.font = fontCss;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center';
    ctx.fillStyle = fill;
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  }

  function tick() {
    const s = getSnap();
    ensure();
    const frozen = s.visual.sceneFrozen;
    if (!frozen) relaxRope();

    clearNeutral(ctx, s.w, s.h, s.visual.stageBackground);
    applyMultiplyBlend(ctx, s.visual.multiplyBlend);

    const fills =
      dragIdx >= 0 ? [...stretchGapFills(), ...gapFills(dragIdx)] : stretchGapFills();

    for (const f of fills) {
      drawLetterAt(
        f.ch,
        f.x,
        f.y,
        f.ang,
        f.a,
        colorForGlyph({
          mode: s.visual.colorMode,
          monochrome: s.visual.monochromeColor,
          seed: s.visual.rainbowSeed,
          index: 2,
          total: 5,
        }),
        s.fontCss,
      );
    }

    for (let i = 0; i < chars.length; i++) {
      let ang = 0;
      if (i > 0 && i < chars.length - 1) {
        ang = segmentAngle(bx[i - 1]!, by[i - 1]!, bx[i + 1]!, by[i + 1]!);
      } else if (i === 0 && chars.length > 1) {
        ang = segmentAngle(bx[0]!, by[0]!, bx[1]!, by[1]!);
      } else if (i === chars.length - 1 && chars.length > 1) {
        ang = segmentAngle(bx[i - 1]!, by[i - 1]!, bx[i]!, by[i]!);
      }
      drawLetterAt(
        chars[i]!,
        bx[i]!,
        by[i]!,
        ang,
        1,
        colorForGlyph({
          mode: s.visual.colorMode,
          monochrome: s.visual.monochromeColor,
          seed: s.visual.rainbowSeed,
          index: i,
          total: chars.length,
        }),
        s.fontCss,
      );
    }
  }

  return {
    start() {
      layoutSig = '';
      tickerFn = () => tick();
      gsap.ticker.add(tickerFn);
      down = (e: PointerEvent) => {
        if (getSnap().visual.sceneFrozen) return;
        const r = canvas.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        dragIdx = hit(px, py);
        if (dragIdx >= 0) {
          grabOx = px - bx[dragIdx]!;
          grabOy = py - by[dragIdx]!;
        }
        canvas.setPointerCapture(e.pointerId);
      };
      move = (e: PointerEvent) => {
        if (dragIdx < 0 || getSnap().visual.sceneFrozen) return;
        const r = canvas.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        bx[dragIdx] = px - grabOx;
        by[dragIdx] = py - grabOy;
      };
      up = () => {
        dragIdx = -1;
      };
      canvas.addEventListener('pointerdown', down);
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      canvas.addEventListener('pointercancel', up);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    stop() {
      if (tickerFn) gsap.ticker.remove(tickerFn);
      tickerFn = null;
      if (down) canvas.removeEventListener('pointerdown', down);
      if (move) canvas.removeEventListener('pointermove', move);
      if (up) {
        canvas.removeEventListener('pointerup', up);
        canvas.removeEventListener('pointercancel', up);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      }
      down = move = up = null;
    },
    dispose() {
      this.stop();
    },
  };
}
