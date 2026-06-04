import { useCallback, useMemo, useRef, useState } from 'react';
import { FONT_FAMILIES, getFontFamilyById } from './config/fontRegistry';
import { useFontLoader } from './hooks/useFontLoader';
import { useOpenTypeFont } from './hooks/useOpenTypeFont';
import {
  DEFAULT_PLAYGROUND_VISUAL,
  LAB_MODES,
  type LabModeId,
  type PlaygroundVisualState,
} from './types/playground';
import { buildCanvasFont, layoutGlyphs, measureLineWidth } from './utils/textLayout';
import { exportCanvasPng } from './utils/exportPng';
import { downloadTextFile, exportStaticSvg } from './utils/exportSvg';
import { LabeledSlider } from './components/ui/LabeledSlider';
import { RoundButton } from './components/ui/RoundButton';
import { RoundToggle } from './components/ui/RoundToggle';
import { PlaygroundCanvas } from './components/playground/PlaygroundCanvas';

const DEFAULT_FAMILY = FONT_FAMILIES[0]?.id ?? 'ony-byte';
const DEFAULT_WEIGHT =
  FONT_FAMILIES[0]?.weights.find((w) => w.id === 'regular')?.id ??
  FONT_FAMILIES[0]?.weights[0]?.id ??
  'regular';

function modeHint(mode: LabModeId): string {
  switch (mode) {
    case 'expansion':
      return 'Цепочка контуров: Offset + Smooth от предыдущей формы';
    case 'colorStack':
      return 'Залитые копии со смещением — имитация объёма';
    case 'bloom':
      return 'Веди курсором — буквы отступают; след от движения';
    case 'assembly':
      return 'Поток букв собирается в слово; в покое — глитч';
    case 'symbol':
      return 'Клик — вкл/выкл символ поверх буквы';
    case 'elastic':
      return 'Градиентный поток от букв в заданном направлении';
    case 'trailWalker':
      return 'Текст блуждает по экрану и оставляет цветной след';
    case 'softBody':
      return 'Непрерывный поток букв по полю; эхо-след';
    default:
      return '';
  }
}

export default function App() {
  const [mode, setMode] = useState<LabModeId>('bloom');
  const [text, setText] = useState(DEFAULT_PLAYGROUND_VISUAL.text);
  const [visual, setVisual] = useState<PlaygroundVisualState>(DEFAULT_PLAYGROUND_VISUAL);
  const [familyId, setFamilyId] = useState(DEFAULT_FAMILY);
  const [weightId, setWeightId] = useState(DEFAULT_WEIGHT);
  const [hasTyped, setHasTyped] = useState(false);
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);

  const displayText = visual.forceUppercase ? text.toUpperCase() : text;

  const family = getFontFamilyById(familyId) ?? FONT_FAMILIES[0]!;
  const weight =
    family.weights.find((w) => w.id === weightId) ?? family.weights[0] ?? FONT_FAMILIES[0]!.weights[0]!;

  const { ready: fontReady, fontUrl } = useFontLoader(family.cssFamily, weight.file, weight.cssWeight);
  const opentypeFont = useOpenTypeFont(fontReady ? fontUrl : null);

  const fontCss = useMemo(
    () => buildCanvasFont(family.cssFamily, weight.cssWeight, visual.fontSize),
    [family.cssFamily, weight.cssWeight, visual.fontSize],
  );

  const onCanvasReady = useCallback((el: HTMLCanvasElement) => {
    canvasElRef.current = el;
  }, []);

  const randomizeColors = () => {
    setVisual((v) => ({ ...v, rainbowSeed: Math.random() * 1000 }));
  };

  const resetModeSettings = () => {
    setVisual({ ...DEFAULT_PLAYGROUND_VISUAL });
  };

  const clearCanvas = () => {
    setVisual((v) => ({ ...v, canvasClearNonce: (v.canvasClearNonce ?? 0) + 1 }));
  };

  const resetEverything = () => {
    setText(DEFAULT_PLAYGROUND_VISUAL.text);
    setVisual({ ...DEFAULT_PLAYGROUND_VISUAL });
    setFamilyId(DEFAULT_FAMILY);
    setWeightId(DEFAULT_WEIGHT);
    setMode('bloom');
    setHasTyped(false);
  };

  const exportPng = () => {
    const c = canvasElRef.current;
    if (c) exportCanvasPng(c, 'ony-type-lab.png');
  };

  const exportSvg = async () => {
    const c = canvasElRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const w = c.clientWidth;
    const h = c.clientHeight;
    const tw = measureLineWidth(ctx, displayText, fontCss, visual.letterSpacing);
    const ox = (w - tw) * 0.5;
    const oy = h * 0.55;
    const layouts = layoutGlyphs(ctx, displayText, fontCss, visual.fontSize, visual.letterSpacing, ox, oy);
    const fill =
      visual.colorMode === 'monochrome'
        ? visual.monochromeColor
        : '#111111';
    const svg = await exportStaticSvg({
      fontUrl,
      layouts,
      fontSize: visual.fontSize,
      width: w,
      height: h,
      fill,
      multiplyBlend: visual.multiplyBlend,
      stageBackground: visual.stageBackground,
    });
    downloadTextFile(svg, 'ony-type-lab.svg');
  };

  return (
    <div className="lab">
      <aside className="lab__panel">
        <div className="lab__brand">ONY Agency</div>
        <h1 className="lab__title">Typography Lab</h1>

        <div className="lab__row">
          <RoundButton onClick={resetModeSettings}>Настройки режимов</RoundButton>
          <RoundButton onClick={clearCanvas}>Очистить экран</RoundButton>
          <RoundButton onClick={resetEverything}>Сброс всего</RoundButton>
        </div>
        <div className="lab__row">
          <RoundButton onClick={exportPng} disabled={!fontReady}>
            PNG
          </RoundButton>
          <RoundButton onClick={() => void exportSvg()} disabled={!fontReady}>
            SVG
          </RoundButton>
        </div>

        <div className="lab__field">
          <label htmlFor="lab-font">Шрифт</label>
          <select
            id="lab-font"
            value={familyId}
            onChange={(e) => {
              const id = e.target.value;
              setFamilyId(id);
              const nf = getFontFamilyById(id);
              setWeightId(nf?.weights[0]?.id ?? DEFAULT_WEIGHT);
            }}
          >
            {FONT_FAMILIES.map((f) => (
              <option key={f.id} value={f.id}>
                {f.displayName}
              </option>
            ))}
          </select>
        </div>

        <div className="lab__field">
          <label htmlFor="lab-weight">Начертание</label>
          <select
            id="lab-weight"
            value={weight.id}
            onChange={(e) => {
              const w = family.weights.find((x) => x.id === e.target.value);
              if (w) setWeightId(w.id);
            }}
          >
            {family.weights.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
        </div>

        <LabeledSlider
          label="Кегль"
          min={8}
          max={200}
          freeInput
          value={visual.fontSize}
          onChange={(v) => setVisual((s) => ({ ...s, fontSize: v }))}
        />
        <LabeledSlider
          label="Межбуквенный"
          min={-40}
          max={120}
          freeInput
          value={visual.letterSpacing}
          onChange={(v) => setVisual((s) => ({ ...s, letterSpacing: v }))}
        />
        <LabeledSlider
          label="Непрозрачность эффекта"
          min={0}
          max={1}
          step={0.01}
          value={visual.effectOpacity}
          format={(n) => `${Math.round(n * 100)}%`}
          onChange={(v) => setVisual((s) => ({ ...s, effectOpacity: v }))}
        />
        <div className="lab__row">
          <RoundToggle
            label="ВСЕ ЗАГЛАВНЫЕ"
            pressed={visual.forceUppercase}
            onChange={(v) => setVisual((s) => ({ ...s, forceUppercase: v }))}
          />
        </div>

        <div className="lab__row">
          <RoundToggle
            label="Анимация"
            pressed={visual.animationEnabled}
            onChange={(v) => setVisual((s) => ({ ...s, animationEnabled: v }))}
          />
          <RoundToggle
            label="Multiply"
            pressed={visual.multiplyBlend}
            onChange={(v) => setVisual((s) => ({ ...s, multiplyBlend: v }))}
          />
          <RoundToggle
            label="Стоп (экспорт)"
            pressed={visual.sceneFrozen}
            onChange={(v) => setVisual((s) => ({ ...s, sceneFrozen: v }))}
          />
        </div>

        <div className="lab__section-title">Цвет</div>
        <div className="lab__row">
          <RoundButton
            active={visual.colorMode === 'monochrome'}
            onClick={() => setVisual((s) => ({ ...s, colorMode: 'monochrome' }))}
          >
            Mono
          </RoundButton>
          <RoundButton
            active={visual.colorMode === 'rainbow'}
            onClick={() => setVisual((s) => ({ ...s, colorMode: 'rainbow' }))}
          >
            Rainbow
          </RoundButton>
          <RoundButton onClick={randomizeColors}>Random palette</RoundButton>
        </div>
        {visual.colorMode === 'monochrome' && (
          <div className="lab__field">
            <label htmlFor="lab-mono">Цвет</label>
            <input
              id="lab-mono"
              type="color"
              value={visual.monochromeColor}
              onChange={(e) => setVisual((s) => ({ ...s, monochromeColor: e.target.value }))}
            />
          </div>
        )}

        <div className="lab__section-title">Холст</div>
        <div className="lab__field lab__field--row">
          <label htmlFor="lab-bg">Фон</label>
          <input
            id="lab-bg"
            type="color"
            value={visual.stageBackground === 'transparent' ? '#f4f3f0' : visual.stageBackground}
            disabled={visual.stageBackground === 'transparent'}
            onChange={(e) => setVisual((s) => ({ ...s, stageBackground: e.target.value }))}
          />
          <RoundToggle
            label="Прозрачный"
            pressed={visual.stageBackground === 'transparent'}
            onChange={(on) =>
              setVisual((s) => ({
                ...s,
                stageBackground: on ? 'transparent' : '#f4f3f0',
              }))
            }
          />
        </div>

        <div className="lab__section-title">Режим</div>
        <div className="lab__row">
          {LAB_MODES.map((m) => (
            <RoundButton key={m.id} active={mode === m.id} onClick={() => setMode(m.id)}>
              {m.shortLabel}
            </RoundButton>
          ))}
        </div>

        {mode === 'expansion' && (
          <>
            <LabeledSlider
              label="Шаг волн"
              min={1}
              max={24}
              freeInput
              value={visual.expansion.ringSpacing ?? DEFAULT_PLAYGROUND_VISUAL.expansion.ringSpacing}
              onChange={(v) => setVisual((s) => ({ ...s, expansion: { ...s.expansion, ringSpacing: v } }))}
            />
            <LabeledSlider
              label="Количество контуров"
              min={4}
              max={150}
              freeInput
              value={visual.expansion.contourCount ?? DEFAULT_PLAYGROUND_VISUAL.expansion.contourCount}
              onChange={(v) =>
                setVisual((s) => ({
                  ...s,
                  expansion: { ...s.expansion, contourCount: Math.round(v) },
                }))
              }
            />
            <LabeledSlider
              label="Толщина контура"
              min={0.2}
              max={8}
              step={0.1}
              freeInput
              value={visual.expansion.strokeWidth}
              onChange={(v) => setVisual((s) => ({ ...s, expansion: { ...s.expansion, strokeWidth: v } }))}
            />
            <LabeledSlider
              label="Скорость роста"
              min={0}
              max={2}
              step={0.02}
              freeInput
              value={visual.expansion.growSpeed}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, expansion: { ...s.expansion, growSpeed: v } }))}
            />
            <LabeledSlider
              label="Шаг расширения"
              min={0.2}
              max={3}
              step={0.05}
              freeInput
              value={visual.expansion.offsetScale}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, expansion: { ...s.expansion, offsetScale: v } }))}
            />
            <LabeledSlider
              label="Сглаживание"
              min={0}
              max={1}
              step={0.02}
              value={visual.expansion.waveFlatten}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, expansion: { ...s.expansion, waveFlatten: v } }))}
            />
            <div className="lab__field lab__field--row">
              <label htmlFor="exp-stroke">Цвет контура</label>
              <input
                id="exp-stroke"
                type="color"
                value={
                  visual.expansion.strokeColor === 'auto'
                    ? visual.monochromeColor
                    : visual.expansion.strokeColor
                }
                onChange={(e) =>
                  setVisual((s) => ({
                    ...s,
                    expansion: { ...s.expansion, strokeColor: e.target.value },
                  }))
                }
              />
              <RoundToggle
                label="Режим цвета"
                pressed={visual.expansion.strokeColor === 'auto'}
                onChange={(on) =>
                  setVisual((s) => ({
                    ...s,
                    expansion: { ...s.expansion, strokeColor: on ? 'auto' : s.monochromeColor },
                  }))
                }
              />
            </div>
          </>
        )}

        {mode === 'colorStack' && (
          <>
            <LabeledSlider
              label="Копии"
              min={2}
              max={80}
              freeInput
              value={visual.colorStack.duplicateCount}
              onChange={(v) => setVisual((s) => ({ ...s, colorStack: { ...s.colorStack, duplicateCount: v } }))}
            />
            <LabeledSlider
              label="Угол"
              min={-180}
              max={180}
              freeInput
              value={visual.colorStack.angleDeg}
              onChange={(v) => setVisual((s) => ({ ...s, colorStack: { ...s.colorStack, angleDeg: v } }))}
            />
            <LabeledSlider
              label="Смещение X"
              min={-3}
              max={3}
              step={0.05}
              freeInput
              value={visual.colorStack.offsetX}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, colorStack: { ...s.colorStack, offsetX: v } }))}
            />
            <LabeledSlider
              label="Смещение Y"
              min={-3}
              max={3}
              step={0.05}
              freeInput
              value={visual.colorStack.offsetY}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, colorStack: { ...s.colorStack, offsetY: v } }))}
            />
            <div className="lab__field lab__field--row">
              <label htmlFor="stack-color">Цвет стека</label>
              <input
                id="stack-color"
                type="color"
                value={visual.colorStack.stackColor}
                onChange={(e) =>
                  setVisual((s) => ({ ...s, colorStack: { ...s.colorStack, stackColor: e.target.value } }))
                }
              />
            </div>
            <RoundToggle
              label="Радуга в стеке"
              pressed={visual.colorStack.useRainbowStack}
              onChange={(v) => setVisual((s) => ({ ...s, colorStack: { ...s.colorStack, useRainbowStack: v } }))}
            />
          </>
        )}

        {mode === 'bloom' && (
          <>
            <LabeledSlider
              label="Радиус влияния"
              min={0.35}
              max={2.2}
              step={0.02}
              value={visual.bloom.interactionRadius}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, bloom: { ...s.bloom, interactionRadius: v } }))}
            />
            <LabeledSlider
              label="Смещение букв"
              min={0.08}
              max={1.2}
              step={0.02}
              value={visual.bloom.displacementStrength}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, bloom: { ...s.bloom, displacementStrength: v } }))}
            />
            <LabeledSlider
              label="След"
              min={0}
              max={1}
              step={0.02}
              value={visual.bloom.trailAmount}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, bloom: { ...s.bloom, trailAmount: v } }))}
            />
            <LabeledSlider
              label="Жизнь следа"
              min={0.15}
              max={1}
              step={0.02}
              value={visual.bloom.trailLifetime}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, bloom: { ...s.bloom, trailLifetime: v } }))}
            />
            <LabeledSlider
              label="Возврат"
              min={0.12}
              max={1.4}
              step={0.02}
              value={visual.bloom.returnSpeed}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, bloom: { ...s.bloom, returnSpeed: v } }))}
            />
            <LabeledSlider
              label="Вытягивание следа"
              min={0}
              max={1}
              step={0.02}
              value={visual.bloom.trailStretch}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, bloom: { ...s.bloom, trailStretch: v } }))}
            />
            <LabeledSlider
              label="Разброс размера"
              min={0}
              max={1}
              step={0.02}
              value={visual.bloom.trailSizeVariance}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, bloom: { ...s.bloom, trailSizeVariance: v } }))}
            />
          </>
        )}

        {mode === 'assembly' && (
          <>
            <LabeledSlider
              label="Глубина следа"
              min={4}
              max={24}
              step={1}
              value={visual.assembly.inwardCopies}
              onChange={(v) => setVisual((s) => ({ ...s, assembly: { ...s.assembly, inwardCopies: v } }))}
            />
            <LabeledSlider
              label="Завихрение потока"
              min={0.4}
              max={2.2}
              step={0.02}
              value={visual.assembly.orbitRadius}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, assembly: { ...s.assembly, orbitRadius: v } }))}
            />
            <LabeledSlider
              label="Сила сборки"
              min={0.12}
              max={0.85}
              step={0.01}
              value={visual.assembly.mergeSpeed}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, assembly: { ...s.assembly, mergeSpeed: v } }))}
            />
            <LabeledSlider
              label="Глитч-шаг"
              min={1}
              max={12}
              value={visual.assembly.pixelJump}
              onChange={(v) => setVisual((s) => ({ ...s, assembly: { ...s.assembly, pixelJump: v } }))}
            />
            <LabeledSlider
              label="Скорость потока"
              min={0.15}
              max={1}
              step={0.01}
              value={visual.assembly.drift}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, assembly: { ...s.assembly, drift: v } }))}
            />
            <div className="lab__row">
              <RoundToggle
                label="Overlap"
                pressed={visual.assembly.overlap}
                onChange={(v) => setVisual((s) => ({ ...s, assembly: { ...s.assembly, overlap: v } }))}
              />
            </div>
          </>
        )}

        {mode === 'symbol' && (
          <>
            <div className="lab__row">
              <RoundButton
                active={visual.symbol.interaction === 'clickToggle'}
                onClick={() =>
                  setVisual((s) => ({ ...s, symbol: { ...s.symbol, interaction: 'clickToggle' } }))
                }
              >
                Клик
              </RoundButton>
              <RoundButton
                active={visual.symbol.interaction === 'alwaysOn'}
                onClick={() => setVisual((s) => ({ ...s, symbol: { ...s.symbol, interaction: 'alwaysOn' } }))}
              >
                Всегда
              </RoundButton>
            </div>
            <LabeledSlider
              label="Сила оверлея"
              min={0.2}
              max={1.2}
              step={0.02}
              value={visual.symbol.symbolDensity}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, symbol: { ...s.symbol, symbolDensity: v } }))}
            />
            <LabeledSlider
              label="Смена каждые N кадров"
              min={6}
              max={60}
              value={visual.symbol.swapEveryFrames}
              onChange={(v) => setVisual((s) => ({ ...s, symbol: { ...s.symbol, swapEveryFrames: v } }))}
            />
          </>
        )}

        {mode === 'elastic' && (
          <>
            <LabeledSlider
              label="Длина потока"
              min={4}
              max={120}
              freeInput
              value={visual.elastic.flowLength}
              onChange={(v) => setVisual((s) => ({ ...s, elastic: { ...s.elastic, flowLength: v } }))}
            />
            <LabeledSlider
              label="Направление °"
              min={-180}
              max={180}
              freeInput
              value={visual.elastic.directionDeg}
              onChange={(v) => setVisual((s) => ({ ...s, elastic: { ...s.elastic, directionDeg: v } }))}
            />
            <LabeledSlider
              label="Шаг смещения"
              min={0.1}
              max={3}
              step={0.05}
              freeInput
              value={visual.elastic.stepSize}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, elastic: { ...s.elastic, stepSize: v } }))}
            />
            <RoundToggle
              label="Случайный градиент"
              pressed={visual.elastic.randomGradient}
              onChange={(v) => setVisual((s) => ({ ...s, elastic: { ...s.elastic, randomGradient: v } }))}
            />
            {!visual.elastic.randomGradient && (
              <>
                <div className="lab__field lab__field--row">
                  <label htmlFor="g-a">Цвет A</label>
                  <input
                    id="g-a"
                    type="color"
                    value={visual.elastic.colorA}
                    onChange={(e) =>
                      setVisual((s) => ({ ...s, elastic: { ...s.elastic, colorA: e.target.value } }))
                    }
                  />
                  <label htmlFor="g-b">B</label>
                  <input
                    id="g-b"
                    type="color"
                    value={visual.elastic.colorB}
                    onChange={(e) =>
                      setVisual((s) => ({ ...s, elastic: { ...s.elastic, colorB: e.target.value } }))
                    }
                  />
                  <label htmlFor="g-c">C</label>
                  <input
                    id="g-c"
                    type="color"
                    value={visual.elastic.colorC}
                    onChange={(e) =>
                      setVisual((s) => ({ ...s, elastic: { ...s.elastic, colorC: e.target.value } }))
                    }
                  />
                </div>
              </>
            )}
          </>
        )}

        {mode === 'trailWalker' && (
          <>
            <LabeledSlider
              label="Скорость"
              min={0.05}
              max={2}
              step={0.02}
              freeInput
              value={visual.trailWalker.speed}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, trailWalker: { ...s.trailWalker, speed: v } }))}
            />
            <LabeledSlider
              label="Длина следа"
              min={4}
              max={120}
              freeInput
              value={visual.trailWalker.trailLength}
              onChange={(v) => setVisual((s) => ({ ...s, trailWalker: { ...s.trailWalker, trailLength: v } }))}
            />
            <LabeledSlider
              label="«Червячок»"
              min={0}
              max={1}
              step={0.02}
              freeInput
              value={visual.trailWalker.worminess}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, trailWalker: { ...s.trailWalker, worminess: v } }))}
            />
            <div className="lab__field lab__field--row">
              <label htmlFor="walk-color">Цвет следа</label>
              <input
                id="walk-color"
                type="color"
                value={visual.trailWalker.trailColor}
                onChange={(e) =>
                  setVisual((s) => ({ ...s, trailWalker: { ...s.trailWalker, trailColor: e.target.value } }))
                }
              />
            </div>
          </>
        )}

        {mode === 'softBody' && (
          <>
            <LabeledSlider
              label="Копии вихря"
              min={1}
              max={16}
              step={1}
              value={visual.softBody.vortexCopies}
              onChange={(v) => setVisual((s) => ({ ...s, softBody: { ...s.softBody, vortexCopies: v } }))}
            />
            <LabeledSlider
              label="Глубина следа"
              min={4}
              max={24}
              step={1}
              value={visual.softBody.trailDepth}
              onChange={(v) => setVisual((s) => ({ ...s, softBody: { ...s.softBody, trailDepth: v } }))}
            />
            <LabeledSlider
              label="Завихрение потока"
              min={0.4}
              max={2.2}
              step={0.02}
              value={visual.softBody.swirl}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, softBody: { ...s.softBody, swirl: v } }))}
            />
            <LabeledSlider
              label="Скорость потока"
              min={0.15}
              max={1.2}
              step={0.02}
              value={visual.softBody.flowSpeed}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, softBody: { ...s.softBody, flowSpeed: v } }))}
            />
            <LabeledSlider
              label="Pixel jump"
              min={1}
              max={12}
              value={visual.softBody.pixelJump}
              onChange={(v) => setVisual((s) => ({ ...s, softBody: { ...s.softBody, pixelJump: v } }))}
            />
            <LabeledSlider
              label="Drift"
              min={0.05}
              max={1}
              step={0.01}
              value={visual.softBody.drift}
              format={(n) => n.toFixed(2)}
              onChange={(v) => setVisual((s) => ({ ...s, softBody: { ...s.softBody, drift: v } }))}
            />
            <div className="lab__row">
              <RoundToggle
                label="Overlap"
                pressed={visual.softBody.overlap}
                onChange={(v) => setVisual((s) => ({ ...s, softBody: { ...s.softBody, overlap: v } }))}
              />
            </div>
          </>
        )}
      </aside>

      <main
        ref={stageRef}
        className="lab__stage"
        tabIndex={0}
        onPointerDown={() => stageRef.current?.focus()}
      >
        <PlaygroundCanvas
          mode={mode}
          text={displayText}
          fontCss={fontCss}
          fontUrl={fontUrl}
          fontReady={fontReady}
          fontSize={visual.fontSize}
          letterSpacing={visual.letterSpacing}
          visual={visual}
          animationEnabled={visual.animationEnabled}
          opentypeFont={opentypeFont}
          onCanvasReady={onCanvasReady}
          onTextChange={(t) => {
            setHasTyped(true);
            setText(t);
          }}
          forceUppercase={visual.forceUppercase}
          stageRef={stageRef}
        />
        {!hasTyped && (
          <p className="lab__type-prompt">начни вводить текст — кликни на холст и печатай</p>
        )}
        <div className="lab__hint">{modeHint(mode)}</div>
      </main>
    </div>
  );
}
