type Props = {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
};

export function LabeledSlider({ label, min, max, step = 1, value, onChange, format }: Props) {
  const text = format ? format(value) : String(value);
  return (
    <label className="slider">
      <div className="slider__head">
        <span>{label}</span>
        <span className="slider__val">{text}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
