import type opentype from 'opentype.js';
import type { LabModeId } from '../types/playground';
import type { PlaygroundVisualState } from '../types/playground';

export interface ModeSnapshot {
  w: number;
  h: number;
  mode: LabModeId;
  text: string;
  fontCss: string;
  fontUrl: string;
  fontSize: number;
  letterSpacing: number;
  visual: PlaygroundVisualState;
  animationEnabled: boolean;
  opentypeFont: opentype.Font | null;
}

export interface ModeController {
  start(): void;
  stop(): void;
  dispose(): void;
}
