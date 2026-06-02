import type { ColorModeId } from '../types/playground';

export function hsla(h: number, s: number, l: number, a = 1): string {
  return `hsla(${h % 360}, ${s}%, ${l}%, ${a})`;
}

export function rainbowStops(seed: number, count = 5): string[] {
  const out: string[] = [];
  const base = seed * 47.13;
  for (let i = 0; i < count; i++) {
    const h = base + (i * 360) / count;
    out.push(hsla(h, 88, 52, 1));
  }
  return out;
}

export function randomVividPalette(seed: number, n = 6): string[] {
  const rng = mulberry32(Math.floor(seed * 10000));
  const colors: string[] = [];
  for (let i = 0; i < n; i++) {
    const h = rng() * 360;
    const s = 78 + rng() * 18;
    const l = 48 + rng() * 12;
    colors.push(hsla(h, s, l, 0.92));
  }
  return colors;
}

export function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function colorForGlyph(options: {
  mode: ColorModeId;
  monochrome: string;
  seed: number;
  index: number;
  total: number;
}): string {
  if (options.mode === 'monochrome') return options.monochrome;
  const h = options.seed * 41 + (options.index / Math.max(1, options.total)) * 220;
  return hsla(h, 90, 54, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function parseHex(hex: string): [number, number, number] | null {
  const h = hex.replace('#', '').trim();
  if (h.length === 3) {
    return [
      parseInt(h[0]! + h[0], 16),
      parseInt(h[1]! + h[1], 16),
      parseInt(h[2]! + h[2], 16),
    ];
  }
  if (h.length === 6) {
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  return null;
}

export function lerpColor(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return t < 0.5 ? a : b;
  const r = Math.round(lerp(ca[0], cb[0], t));
  const g = Math.round(lerp(ca[1], cb[1], t));
  const bl = Math.round(lerp(ca[2], cb[2], t));
  return `rgb(${r},${g},${bl})`;
}

export function gradientAt(colors: string[], t: number): string {
  if (colors.length === 0) return '#000';
  if (colors.length === 1) return colors[0]!;
  const u = clamp(t, 0, 1) * (colors.length - 1);
  const i = Math.floor(u);
  const f = u - i;
  return lerpColor(colors[i]!, colors[Math.min(i + 1, colors.length - 1)]!, f);
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
