export function Switch({ checked, onChange, label, disabled, title }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} className={`switch${checked ? " on" : ""}`}
      disabled={disabled} title={title} onClick={() => onChange(!checked)}>
      <span className="switch-track" aria-hidden><span className="switch-knob" /></span>
      <span className="switch-label">{label}</span>
    </button>
  );
}
