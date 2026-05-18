export type LabModeId =
  | 'expansion'
  | 'bloom'
  | 'assembly'
  | 'symbol'
  | 'elastic'
  | 'softBody';

export type ColorModeId = 'monochrome' | 'rainbow';

export type SymbolInteractionId = 'clickToggle' | 'alwaysOn';

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
  { id: 'softBody', label: 'Вихрь', shortLabel: 'Вихрь' },
];

export interface ExpansionSettings {
  /** плотность водопада (капель на активную букву) */
  waterfallDensity: number;
  /** горизонтальный разброс падающих букв */
  spread: number;
  /** скорость падения */
  fallSpeed: number;
  /** лёгкое покачивание при падении */
  sway: number;
  /** ветер: −1 влево, +1 вправо */
  wind: number;
}

export interface BloomSettings {
  /** радиус зоны влияния курсора */
  interactionRadius: number;
  /** сила смещения букв от курсора */
  displacementStrength: number;
  /** плотность типографического следа */
  trailAmount: number;
  /** длительность затухания следа */
  trailLifetime: number;
  /** скорость пружинного возврата букв */
  returnSpeed: number;
  /** вытягивание фрагментов следа по скорости */
  trailStretch: number;
  /** разброс размера фрагментов следа */
  trailSizeVariance: number;
}

export interface AssemblySettings {
  overlap: boolean;
  /** эхо-след в полёте к слову */
  inwardCopies: number;
  /** завихрение потока */
  orbitRadius: number;
  /** сила притяжения к слову */
  mergeSpeed: number;
  /** шаг пиксельного глитча в покое */
  pixelJump: number;
  /** скорость бесконечного потока */
  drift: number;
}

export interface SymbolSettings {
  /** клик по букве — вкл/выкл оверлей; всегда — на всех буквах */
  interaction: SymbolInteractionId;
  /** сила оверлея (прозрачность символа) */
  symbolDensity: number;
  /** смена случайного символа каждые N кадров */
  swapEveryFrames: number;
}

export interface ElasticSettings {
  /** расстояние между копиями в зазоре */
  fillSpacing: number;
}

export interface SoftBodySettings {
  overlap: boolean;
  /** повторы слова в потоке: 1 = одна строка, больше = плотнее «вихрь» */
  vortexCopies: number;
  /** глубина «эхо»-слоя в направлении потока */
  trailDepth: number;
  /** завихрение поля */
  swirl: number;
  /** скорость основного течения */
  flowSpeed: number;
  /** пиксельная сетка микросмещения (1 = выкл) */
  pixelJump: number;
  /** сила и характер потока */
  drift: number;
}

export interface PlaygroundVisualState {
  text: string;
  fontSize: number;
  letterSpacing: number;
  /** Фон сцены: hex/rgb или слово `transparent` для PNG с альфой */
  stageBackground: string;
  /** Увеличить, чтобы режимы сбросили нарисованное состояние (без смены настроек) */
  canvasClearNonce: number;
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
  stageBackground: '#fafaf9',
  canvasClearNonce: 0,
  multiplyBlend: false,
  animationEnabled: true,
  sceneFrozen: false,
  colorMode: 'monochrome',
  monochromeColor: '#0a0a0a',
  rainbowSeed: 1,
  expansion: {
    waterfallDensity: 0.55,
    spread: 0.45,
    fallSpeed: 0.48,
    sway: 0.35,
    wind: 0,
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
    fillSpacing: 0.48,
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
