type SwitchProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <label className={`switch-row${disabled ? ' disabled' : ''}`}>
      <span className="switch-label">{label}</span>
      <button
        type="button"
        className={`switch${checked ? ' on' : ''}`}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-thumb" />
      </button>
    </label>
  )
}
