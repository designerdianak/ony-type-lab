import type { ExpansionSettings, RippleDistribution } from '../types/playground';
import { smoothBinaryMask } from './iterativeContours';

/** Скорость бесконечного потока — фиксирована. */
export const RIPPLE_FLOW_SPEED = 0.4;

const SMOOTH_PASSES = 2;
const SMOOTH_THRESHOLD = 0.42;
const BIAS_STRENGTH = 0.85;

/** Фиксированная дальность до края экрана (Count только уплотняет, не расширяет). */
export function rippleReach(w: number, h: number, biasX: number, biasY: number): number {
  const base = Math.max(w, h) * 0.55;
  const bias = Math.max(Math.abs(biasX), Math.abs(biasY));
  return base * (1 + bias * 0.22);
}

export function rippleBaseStepCells(
  w: number,
  h: number,
  count: number,
  cell: number,
  biasX: number,
  biasY: number,
): number {
  const stepPx = rippleReach(w, h, biasX, biasY) / Math.max(2, count);
  return Math.max(1, stepPx / cell);
}

export function rippleStepRadius(
  gen: number,
  base: number,
  mode: RippleDistribution,
  falloff: number,
): number {
  if (mode === 'uniform') return base;
  return base * (1 + gen * Math.max(0, falloff));
}

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

/** Shapeₙ = Smooth(Offset(Shapeₙ₋₁)) — только от предыдущей оболочки. */
export function offsetFromPrevInto(
  prev: Uint8Array,
  out: Uint8Array,
  gen: number,
  cw: number,
  ch: number,
  baseRadius: number,
  distribution: RippleDistribution,
  falloff: number,
  biasX: number,
  biasY: number,
  work?: Uint8Array,
): Uint8Array {
  const r = rippleStepRadius(gen, baseRadius, distribution, falloff);
  const { rx, ry } = rippleEllipseRadii(r, biasX, biasY);
  dilateEllipseInto(prev, out, cw, ch, rx, ry);
  const smoothed = smoothBinaryMask(out, cw, ch, SMOOTH_PASSES, SMOOTH_THRESHOLD);
  if (work && work.length === out.length) {
    work.set(smoothed);
    out.set(work);
    return out;
  }
  out.set(smoothed);
  return out;
}

export function rippleGridCell(stepPx: number, w: number, h: number): number {
  const cell = Math.max(1.5, Math.min(2.8, stepPx * 0.36));
  const maxCells = 400_000;
  if (Math.ceil(w / cell) * Math.ceil(h / cell) > maxCells) {
    return Math.sqrt((w * h) / maxCells);
  }
  return cell;
}

export function rippleRasterPad(reach: number, w: number, h: number): number {
  return Math.ceil(reach * 1.15 + Math.max(w, h) * 0.12);
}

export function rippleRingFill(exp: ExpansionSettings): string {
  return exp.fillColor;
}

export function rippleStrokeColor(exp: ExpansionSettings, gen: number): string {
  if (exp.paletteMode === 'custom') {
    const pal = exp.customPalette.filter((c) => c.length > 0);
    if (pal.length >= 2) return pal[(gen - 1) % pal.length]!;
  }
  return exp.strokeColor;
}

/** Миграция старых сохранённых настроек. */
export function normalizeExpansion(exp: ExpansionSettings): ExpansionSettings {
  const e = { ...exp };
  const legacy = exp as unknown as Record<string, unknown>;

  if (legacy.spacingMode === 'accelerate') e.distribution = 'falloff';
  if (legacy.spacingMode === 'uniform' && !exp.distribution) e.distribution = 'uniform';
  if (typeof legacy.spacingSpread === 'number' && exp.falloffStrength === undefined) {
    e.falloffStrength = legacy.spacingSpread;
  }
  if (legacy.rippleColorMode === 'custom') e.paletteMode = 'custom';
  if (legacy.rippleColorMode === 'dual') e.paletteMode = 'twoColors';
  if (typeof legacy.flowBiasX === 'number') e.horizontalBias = legacy.flowBiasX;
  if (typeof legacy.flowBiasY === 'number') e.verticalBias = legacy.flowBiasY;
  if (typeof legacy.colorB === 'string' && !exp.strokeColor) e.strokeColor = legacy.colorB;
  if (typeof legacy.colorA === 'string' && !exp.fillColor) e.fillColor = legacy.colorA;
  if (Array.isArray(legacy.customColors) && !exp.customPalette?.length) {
    e.customPalette = legacy.customColors as string[];
  }

  return e;
}
