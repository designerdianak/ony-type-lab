import type { PlaygroundVisualState } from '../types/playground';

/** 0…1 — непрозрачность эффекта (1 = без прозрачности). */
export function effectOpacity(visual: PlaygroundVisualState): number {
  const v = visual.effectOpacity;
  if (v == null || Number.isNaN(v)) return 1;
  return Math.max(0, Math.min(1, v));
}
