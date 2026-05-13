import type { LabModeId } from '../types/playground';
import type { ModeController, ModeSnapshot } from './types';
import { createAssemblyMode } from './assembly';
import { createBloomPaintMode } from './bloomPaint';
import { createElasticLineMode } from './elasticLine';
import { createExpansionMode } from './expansion';
import { createSoftBodyMode } from './softBody';
import { createSymbolOverlayMode } from './symbolOverlay';

export function createModeController(
  mode: LabModeId,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  getSnap: () => ModeSnapshot,
): ModeController {
  switch (mode) {
    case 'expansion':
      return createExpansionMode(canvas, ctx, getSnap);
    case 'bloom':
      return createBloomPaintMode(canvas, ctx, getSnap);
    case 'assembly':
      return createAssemblyMode(canvas, ctx, getSnap);
    case 'symbol':
      return createSymbolOverlayMode(canvas, ctx, getSnap);
    case 'elastic':
      return createElasticLineMode(canvas, ctx, getSnap);
    case 'softBody':
      return createSoftBodyMode(canvas, ctx, getSnap);
    default: {
      const never: never = mode;
      throw new Error(`Unknown mode ${String(never)}`);
    }
  }
}
