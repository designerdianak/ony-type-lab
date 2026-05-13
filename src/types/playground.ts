export type LabModeId =
  | 'expansion'
  | 'bloom'
  | 'assembly'
  | 'symbol'
  | 'elastic'
  | 'softBody';

export type ColorModeId = 'monochrome' | 'rainbow';

export type SymbolInteractionId = 'clickToPaint' | 'alwaysOn';

export interface LabModeDefinition {
  id: LabModeId;
  label: string;
  shortLabel: string;
}

export const LAB_MODES: LabModeDefinition[] = [
  { id: 'expansion', label: 'Expansion', shortLabel: 'Exp' },
  { id: 'bloom', label: 'Bloom Paint', shortLabel: 'Bloom' },
  { id: 'assembly', label: 'Assembly', shortLabel: 'Asm' },
  { id: 'symbol', label: 'Symbol Overlay', shortLabel: 'Sym' },
  { id: 'elastic', label: 'Elastic Line', shortLabel: 'Elastic' },
  { id: 'softBody', label: 'Soft Body', shortLabel: 'Soft' },
];

export interface ExpansionSettings {
  cloneAmount: number;
  spreadForce: number;
  collisionSpacing: number;
  autoGrow: boolean;
}

export interface BloomSettings {
  shapeSize: number;
  growSpeed: number;
  dissolveSpeed: number;
  blur: boolean;
  multiply: boolean;
  motionIntensity: number;
}

export interface AssemblySettings {
  overlap: boolean;
  pixelJump: number;
  drift: number;
}

export interface SymbolSettings {
  interaction: SymbolInteractionId;
  symbolDensity: number;
}

export interface ElasticSettings {
  springK: number;
  damping: number;
  copySpacing: number;
}

export interface SoftBodySettings {
  gravity: boolean;
  softness: number;
  repulsion: number;
}

export interface PlaygroundVisualState {
  text: string;
  fontSize: number;
  letterSpacing: number;
  multiplyBlend: boolean;
  animationEnabled: boolean;
  colorMode: ColorModeId;
  monochromeColor: string;
  rainbowSeed: number;
  expansion: ExpansionSettings;
  bloom: BloomSettings;
  assembly: AssemblySettings;
  symbol: SymbolSettings;
  elastic: ElasticSettings;
  softBody: SoftBodySettings;
}

export const DEFAULT_PLAYGROUND_VISUAL: PlaygroundVisualState = {
  text: 'Play Type',
  fontSize: 72,
  letterSpacing: 0,
  multiplyBlend: false,
  animationEnabled: true,
  colorMode: 'monochrome',
  monochromeColor: '#0a0a0a',
  rainbowSeed: 1,
  expansion: {
    cloneAmount: 3,
    spreadForce: 0.42,
    collisionSpacing: 4,
    autoGrow: false,
  },
  bloom: {
    shapeSize: 1,
    growSpeed: 1,
    dissolveSpeed: 1,
    blur: true,
    multiply: true,
    motionIntensity: 0.55,
  },
  assembly: {
    overlap: true,
    pixelJump: 4,
    drift: 0.35,
  },
  symbol: {
    interaction: 'clickToPaint',
    symbolDensity: 0.65,
  },
  elastic: {
    springK: 0.18,
    damping: 0.86,
    copySpacing: 0.52,
  },
  softBody: {
    gravity: false,
    softness: 0.45,
    repulsion: 0.22,
  },
};
