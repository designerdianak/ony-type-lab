export type LabModeId =
  | 'expansion'
  | 'bloom'
  | 'assembly'
  | 'symbol'
  | 'elastic'
  | 'softBody';

export type ColorModeId = 'monochrome' | 'rainbow';

export type SymbolInteractionId = 'clickToPaint' | 'alwaysOn';

export type SoftLookId = 'metallic' | 'matte';

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
  /** импульс от столкновений (естественное толкание) */
  collisionImpulse: number;
}

export interface BloomSettings {
  shapeSize: number;
  growSpeed: number;
  dissolveSpeed: number;
  blur: boolean;
  multiply: boolean;
  motionIntensity: number;
  /** 0 = реже фигуры, 1 = плотнее */
  figureDensity: number;
  /** амплитуда «растительного» покачивания */
  plantOrganic: number;
  /** как быстро буквы возвращаются, когда поле слабеет */
  letterReturn: number;
  /** баланс: меньше = дольше живёт графика, больше = быстрее исчезает */
  graphicFade: number;
}

export interface AssemblySettings {
  overlap: boolean;
  /** сколько «копий» слетают к каждой букве (preset 2) */
  inwardCopies: number;
  /** радиус старта кольца */
  orbitRadius: number;
  /** скорость схождения */
  mergeSpeed: number;
  /** после сборки — пиксельный дрейф */
  pixelJump: number;
  drift: number;
}

export interface SymbolSettings {
  interaction: SymbolInteractionId;
  symbolDensity: number;
  /** смена символа каждые N кадров тикера */
  swapEveryFrames: number;
}

export interface ElasticSettings {
  /** расстояние между копиями в зазоре */
  fillSpacing: number;
}

export interface SoftBodySettings {
  gravity: boolean;
  softness: number;
  repulsion: number;
  look: SoftLookId;
}

export interface PlaygroundVisualState {
  text: string;
  fontSize: number;
  letterSpacing: number;
  /** Фон сцены: hex/rgb или слово `transparent` для PNG с альфой */
  stageBackground: string;
  multiplyBlend: boolean;
  animationEnabled: boolean;
  /** «Стоп»: зафиксировать кадр для экспорта */
  sceneFrozen: boolean;
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
  stageBackground: '#f4f3f0',
  multiplyBlend: false,
  animationEnabled: true,
  sceneFrozen: false,
  colorMode: 'monochrome',
  monochromeColor: '#0a0a0a',
  rainbowSeed: 1,
  expansion: {
    cloneAmount: 3,
    spreadForce: 0.42,
    collisionSpacing: 2,
    autoGrow: false,
    collisionImpulse: 0.72,
  },
  bloom: {
    shapeSize: 1,
    growSpeed: 1,
    dissolveSpeed: 1,
    blur: true,
    multiply: true,
    motionIntensity: 0.55,
    figureDensity: 0.45,
    plantOrganic: 0.55,
    letterReturn: 0.12,
    graphicFade: 0.5,
  },
  assembly: {
    overlap: true,
    inwardCopies: 12,
    orbitRadius: 1.15,
    mergeSpeed: 0.018,
    pixelJump: 4,
    drift: 0.35,
  },
  symbol: {
    interaction: 'alwaysOn',
    symbolDensity: 0.65,
    swapEveryFrames: 20,
  },
  elastic: {
    fillSpacing: 0.48,
  },
  softBody: {
    gravity: true,
    softness: 0.45,
    repulsion: 0.12,
    look: 'metallic',
  },
};
