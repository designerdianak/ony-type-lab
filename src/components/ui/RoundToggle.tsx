type Props = {
  pressed: boolean;
  onChange: (v: boolean) => void;
  label: string;
  id?: string;
};

export function RoundToggle({ pressed, onChange, label, id }: Props) {
  return (
    <button
      type="button"
      id={id}
      className={`round-toggle ${pressed ? 'round-toggle--on' : ''}`}
      onClick={() => onChange(!pressed)}
      aria-pressed={pressed}
    >
      <span className="round-toggle__dot" />
      <span className="round-toggle__label">{label}</span>
    </button>
  );
}
