import type { ReactNode } from 'react';
import { t, tx } from '../../src/shared/i18n';
import type { Option } from '../../src/shared/types';

/** Each button sends its text as a message, exactly as if it had been typed. */
export function MessageChips({ items, label, className, disabled, onPick }: { items: string[]; label?: string; className?: string; disabled?: boolean; onPick(text: string): void }) {
  if (!items.length) return null;
  return (
    <div className={`chips ${className ?? ''}`} role="group" aria-label={label}>
      {items.map((item) => (
        <button className="chip" key={item} disabled={disabled} onClick={() => onPick(item)}>{item}</button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Select({
  value,
  options,
  onChange,
  custom,
  disabled,
}: {
  value: string;
  options: Option[];
  onChange(value: string): void;
  custom?: boolean;
  disabled?: boolean;
}) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {tx(o.label)}
          {o.hint ? ` · ${tx(o.hint)}` : ''}
        </option>
      ))}
      {custom && <option value="custom">{t('自定义…')}</option>}
    </select>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange(v: boolean): void; label: string; disabled?: boolean }) {
  return (
    <label className={`switch ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" />
      <span>{label}</span>
    </label>
  );
}

export function Progress({ done, total }: { done: number; total?: number }) {
  return (
    <div className={`progress ${total ? '' : 'indeterminate'}`}>
      <div style={total ? { width: `${Math.min(100, (done / total) * 100)}%` } : undefined} />
    </div>
  );
}
