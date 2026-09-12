import { useId } from 'react';
import type { InteractionPreferences } from '@quixi/core/contracts';

interface Props {
  style: InteractionPreferences['modelSwitcherStyle'];
  models: readonly { id: string; name: string }[];
  selected: string;
  placeholder: string;
  disabled: boolean;
  onSelect(modelId: string): void;
}

export function ModelSwitcher({ style, models, selected, placeholder, disabled, onSelect }: Props) {
  const group = useId();
  if (style === 'list') return <fieldset className="model-switcher-list" aria-label="Model choices" disabled={disabled}>
    <legend>Model</legend>
    {!selected && <p className="muted" role="status">{placeholder}</p>}
    {models.map(model => <label key={model.id}>
      <input type="radio" name={group} value={model.id} checked={selected === model.id}
        onChange={() => onSelect(model.id)} />
      <span>{model.name}</span>
    </label>)}
  </fieldset>;
  return <label>
    Model
    <select aria-label="Model" value={selected} disabled={disabled} onChange={event => onSelect(event.target.value)}>
      {!selected && <option value="">{placeholder}</option>}
      {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
    </select>
  </label>;
}
