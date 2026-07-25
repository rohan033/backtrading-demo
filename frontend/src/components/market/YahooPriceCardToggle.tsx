import './YahooPriceCardToggle.css'

type Props = {
  checked: boolean
  onChange: (next: boolean) => void
}

export function YahooPriceCardToggle({ checked, onChange }: Props) {
  return (
    <label
      className="yahoo-card-toggle"
      title="Load Yahoo extended-hours price for this ticker only"
      onClick={event => event.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
      />
      <span className="yahoo-card-toggle__label">Yahoo</span>
    </label>
  )
}
