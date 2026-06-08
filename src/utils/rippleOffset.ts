import type { ExpansionSettings, RippleSpacingMode } from '../types/playground';
import { smoothBinaryMask } from './iterativeContours';

/** Фиксированная скорость портала — не настраивается. */
export const RIPPLE_FLOW_SPEED = 0.42;

const SMOOTH_PASSES = 2;
const SMOOTH_THRESHOLD = 0.42;
const BIAS_STRENGTH = 0.82;

export function ripplePalette(exp: ExpansionSettings): string[] {
  if (exp.rippleColorMode === 'custom') {
    const cols = exp.customColors.filter((c) => c.length > 0);
    if (cols.length >= 2) return cols;
  }
  return [exp.colorA, exp.colorB];
}

export function rippleColorAt(exp: ExpansionSettings, gen: number): string {
  const pal = ripplePalette(exp);
  return pal[(gen - 1) % pal.length]!;
}

/** Дальность потока до края экрана (с учётом смещения). */
export function rippleScreenReach(
  w: number,
  h: number,
  biasX: number,
  biasY: number,
): number {
  const base = Math.max(w, h) * 0.56;
  const bias = Math.max(Math.abs(biasX), Math.abs(biasY));
  return base * (1 + bias * 0.28);
}

/** Базовый шаг offset в ячейках: N копий делят дистанцию до края. */
export function rippleBaseRadiusCells(
  w: number,
  h: number,
  copyCount: number,
  cell: number,
  biasX: number,
  biasY: number,
): number {
  const reach = rippleScreenReach(w, h, biasX, biasY);
  const stepPx = reach / Math.max(2, copyCount);
  return Math.max(1, stepPx / cell);
}

/** Радиус шага для поколения gen (равномерный / с затуханием). */
export function rippleStepRadius(
  gen: number,
  baseRadius: number,
  mode: RippleSpacingMode,
  spread: number,
): number {
  if (mode === 'uniform') return baseRadius;
  return baseRadius * (1 + gen * Math.max(0, spread));
}

/** Эллиптический offset: bias смещает рост по осям (−1…1). */
export function rippleEllipseRadii(
  radiusCells: number,
  biasX: number,
  biasY: number,
): { rx: number; ry: number } {
  const r = Math.max(1, radiusCells);
  const bx = Math.max(-1, Math.min(1, biasX));
  const by = Math.max(-1, Math.min(1, biasY));
  return {
    rx: Math.max(1, Math.round(r * (1 + bx * BIAS_STRENGTH))),
    ry: Math.max(1, Math.round(r * (1 + by * BIAS_STRENGTH))),
  };
}

/** Морфологический offset по эллипсу (Shapeₙ от Shapeₙ₋₁). */
export function dilateEllipseInto(
  prev: Uint8Array,
  out: Uint8Array,
  cw: number,
  ch: number,
  rx: number,
  ry: number,
): void {
  const irx = Math.max(1, Math.round(rx));
  const iry = Math.max(1, Math.round(ry));
  const rx2 = irx * irx;
  const ry2 = iry * iry;

  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let on = 0;
      for (let dy = -iry; dy <= iry && !on; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= ch) continue;
        for (let dx = -irx; dx <= irx; dx++) {
          if ((dx * dx) / rx2 + (dy * dy) / ry2 > 1) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= cw) continue;
          if (prev[yy * cw + xx]) {
            on = 1;
            break;
          }
        }
      }
      out[y * cw + x] = on;
    }
  }
}

/**
 * Один шаг цепочки Cavalry: Offset(предыдущий) + лёгкий Smooth.
 * Каждая копия строится только от предыдущей формы.
 */
export function expandRippleStepInto(
  prev: Uint8Array,
  out: Uint8Array,
  gen: number,
  cw: number,
  ch: number,
  baseRadius: number,
  spacingMode: RippleSpacingMode,
  spacingSpread: number,
  biasX: number,
  biasY: number,
  smoothBuf?: Uint8Array,
): Uint8Array {
  const r = rippleStepRadius(gen, baseRadius, spacingMode, spacingSpread);
  const { rx, ry } = rippleEllipseRadii(r, biasX, biasY);
  dilateEllipseInto(prev, out, cw, ch, rx, ry);
  const smoothed = smoothBinaryMask(out, cw, ch, SMOOTH_PASSES, SMOOTH_THRESHOLD);
  if (smoothBuf && smoothBuf.length === out.length) {
    smoothBuf.set(smoothed);
    out.set(smoothBuf);
    return out;
  }
  out.set(smoothed);
  return out;
}

export function rippleGridCell(stepPx: number, w: number, h: number): number {
  const cell = Math.max(1.5, Math.min(3, stepPx * 0.34));
  const maxCells = 420_000;
  if (Math.ceil(w / cell) * Math.ceil(h / cell) > maxCells) {
    return Math.sqrt((w * h) / maxCells);
  }
  return cell;
}

export function rippleRasterPad(reach: number, w: number, h: number): number {
  return Math.ceil(reach * 1.12 + Math.max(w, h) * 0.1);
}
