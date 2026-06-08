export type LabModeId =
  | 'expansion'
  | 'colorStack'
  | 'bloom'
  | 'assembly'
  | 'symbol'
  | 'elastic'
  | 'trailWalker'
  | 'softBody';

export type ColorModeId = 'monochrome' | 'rainbow';

export type SymbolInteractionId = 'clickToggle' | 'alwaysOn';

export interface LabModeDefinition {
  id: LabModeId;
  label: string;
  shortLabel: string;
}

export const LAB_MODES: LabModeDefinition[] = [
  { id: 'expansion', label: 'Ripple', shortLabel: 'Ripple' },
  { id: 'colorStack', label: 'Volume', shortLabel: 'Volume' },
  { id: 'bloom', label: 'Bloom Paint', shortLabel: 'Bloom' },
  { id: 'assembly', label: 'Assembly', shortLabel: 'Asm' },
  { id: 'symbol', label: 'Symbol Overlay', shortLabel: 'Sym' },
  { id: 'elastic', label: 'Gradient Flow', shortLabel: 'Flow' },
  { id: 'trailWalker', label: 'Trail Walker', shortLabel: 'Walk' },
  { id: 'softBody', label: 'Вихрь', shortLabel: 'Вихрь' },
];

/** Равномерный шаг или falloff — дальше от текста, шире промежуток. */
export type RippleDistribution = 'uniform' | 'falloff';

/** Фон колец + один цвет обводки, или своя палитра обводок. */
export type RipplePaletteMode = 'twoColors' | 'custom';

/**
 * Ripple / Offset Path (Cavalry):
 * Shapeₙ = Offset(Shapeₙ₋₁), кольца с заливкой фона + обводка, текст поверх.
 */
export interface ExpansionSettings {
  /** Count: 2+; больше — плотнее при том же радиусе */
  contourCount: number;
  distribution: RippleDistribution;
  falloffStrength: number;
  paletteMode: RipplePaletteMode;
  /** заливка колец (перекрывает предыдущие обводки) */
  fillColor: string;
  /** обводка контуров (twoColors) */
  strokeColor: string;
  customPalette: string[];
  horizontalBias: number;
  verticalBias: number;
  strokeWidth: number;
}

/** Залитые смещённые копии (объём). */
export interface ColorStackSettings {
  duplicateCount: number;
  angleDeg: number;
  offsetX: number;
  offsetY: number;
  stackColor: string;
  useRainbowStack: boolean;
}

export interface BloomSettings {
  interactionRadius: number;
  displacementStrength: number;
  trailAmount: number;
  trailLifetime: number;
  returnSpeed: number;
  trailStretch: number;
  trailSizeVariance: number;
}

export interface AssemblySettings {
  overlap: boolean;
  inwardCopies: number;
  orbitRadius: number;
  mergeSpeed: number;
  pixelJump: number;
  drift: number;
}

export interface SymbolSettings {
  interaction: SymbolInteractionId;
  symbolDensity: number;
  swapEveryFrames: number;
}

/** Градиентный поток от букв. */
export interface ElasticSettings {
  flowLength: number;
  directionDeg: number;
  stepSize: number;
  randomGradient: boolean;
  colorA: string;
  colorB: string;
  colorC: string;
}

/** Блуждающий текст со следом. */
export interface TrailWalkerSettings {
  speed: number;
  trailLength: number;
  worminess: number;
  trailColor: string;
}

export interface SoftBodySettings {
  overlap: boolean;
  vortexCopies: number;
  trailDepth: number;
  swirl: number;
  flowSpeed: number;
  pixelJump: number;
  drift: number;
}

export interface PlaygroundVisualState {
  text: string;
  fontSize: number;
  letterSpacing: number;
  stageBackground: string;
  canvasClearNonce: number;
  multiplyBlend: boolean;
  animationEnabled: boolean;
  sceneFrozen: boolean;
  colorMode: ColorModeId;
  monochromeColor: string;
  rainbowSeed: number;
  /** 0 = прозрачно, 1 = полностью непрозрачно */
  effectOpacity: number;
  forceUppercase: boolean;
  expansion: ExpansionSettings;
  colorStack: ColorStackSettings;
  bloom: BloomSettings;
  assembly: AssemblySettings;
  symbol: SymbolSettings;
  elastic: ElasticSettings;
  trailWalker: TrailWalkerSettings;
  softBody: SoftBodySettings;
}

export const DEFAULT_PLAYGROUND_VISUAL: PlaygroundVisualState = {
  text: 'Play Type',
  fontSize: 72,
  letterSpacing: 0,
  stageBackground: '#fafaf9',
  canvasClearNonce: 0,
  multiplyBlend: false,
  animationEnabled: true,
  sceneFrozen: false,
  colorMode: 'monochrome',
  monochromeColor: '#0a0a0a',
  rainbowSeed: 1,
  effectOpacity: 1,
  forceUppercase: false,
  expansion: {
    contourCount: 28,
    distribution: 'uniform',
    falloffStrength: 0.1,
    paletteMode: 'twoColors',
    fillColor: '#fafaf9',
    strokeColor: '#0a0a0a',
    customPalette: ['#0a0a0a', '#e91e8c'],
    horizontalBias: 0,
    verticalBias: 0,
    strokeWidth: 1,
  },
  colorStack: {
    duplicateCount: 28,
    angleDeg: 38,
    offsetX: 0.35,
    offsetY: 1.15,
    stackColor: '#e91e8c',
    useRainbowStack: false,
  },
  bloom: {
    interactionRadius: 1.05,
    displacementStrength: 0.52,
    trailAmount: 0.62,
    trailLifetime: 0.72,
    returnSpeed: 0.58,
    trailStretch: 0.48,
    trailSizeVariance: 0.38,
  },
  assembly: {
    overlap: true,
    inwardCopies: 10,
    orbitRadius: 1.05,
    mergeSpeed: 0.38,
    pixelJump: 4,
    drift: 0.52,
  },
  symbol: {
    interaction: 'clickToggle',
    symbolDensity: 0.72,
    swapEveryFrames: 14,
  },
  elastic: {
    flowLength: 42,
    directionDeg: 90,
    stepSize: 0.55,
    randomGradient: true,
    colorA: '#ff2bd6',
    colorB: '#6b2cff',
    colorC: '#00c8ff',
  },
  trailWalker: {
    speed: 0.42,
    trailLength: 36,
    worminess: 0.35,
    trailColor: '#e91e8c',
  },
  softBody: {
    overlap: true,
    vortexCopies: 12,
    trailDepth: 10,
    swirl: 1.1,
    flowSpeed: 0.55,
    pixelJump: 2,
    drift: 0.48,
  },
};
