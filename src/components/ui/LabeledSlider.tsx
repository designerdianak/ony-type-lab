type Props = {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  /** Поле ввода без жёстких границ (ползунок остаётся в min…max). */
  freeInput?: boolean;
};

export function LabeledSlider({
  label,
  min,
  max,
  step = 1,
  value,
  onChange,
  format,
  freeInput = false,
}: Props) {
  const text = format ? format(value) : String(value);
  const sliderVal = freeInput ? Math.max(min, Math.min(max, value)) : value;

  return (
    <label className="slider">
      <div className="slider__head">
        <span>{label}</span>
        {freeInput ? (
          <input
            className="slider__num"
            type="number"
            step={step}
            value={Number.isFinite(value) ? value : 0}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (!Number.isNaN(v)) onChange(v);
            }}
          />
        ) : (
          <span className="slider__val">{text}</span>
        )}
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={sliderVal}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
