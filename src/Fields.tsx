import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

const formatted = (value: number | undefined) =>
  value === undefined ? '' : String(Number(value.toFixed(6)));
export function NumberField({
  label,
  value,
  onChange,
  disabled = false,
  hint = '',
  step = 'any',
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number) => void;
  disabled?: boolean;
  hint?: string;
  step?: string | number;
}) {
  const [draft, setDraft] = useState(formatted(value)),
    cancel = useRef(false);
  useEffect(() => setDraft(formatted(value)), [value]);
  const commit = () => {
    if (cancel.current) {
      cancel.current = false;
      setDraft(formatted(value));
      return;
    }
    if (draft !== '' && Number.isFinite(Number(draft)) && Number(draft) !== value)
      onChange(Number(draft));
    setDraft(formatted(value));
  };
  return (
    <label className="field" data-hint={hint}>
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        step={step}
        disabled={disabled}
        placeholder={value === undefined ? 'Mixed' : undefined}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            cancel.current = true;
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
export function TextField({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value),
    cancel = useRef(false);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="field">
      <span>{label}</span>
      <input
        aria-label={label}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (!cancel.current && draft !== value) onChange(draft);
          cancel.current = false;
          setDraft(value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            cancel.current = true;
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
export function VectorFields({
  label,
  values,
  onChange,
  disabled = false,
  axes,
  hint = '',
}: {
  label: string;
  values: number[];
  onChange: (values: number[]) => void;
  disabled?: boolean;
  axes?: string[];
  hint?: string;
}) {
  return (
    <div className="vector" data-hint={hint}>
      <h4>{label}</h4>
      {values.map((value, i) => (
        <NumberField
          key={i}
          label={
            label +
            ' ' +
            (axes ?? (values.length === 4 ? ['W', 'X', 'Y', 'Z'] : ['X', 'Y', 'Z']))[i]
          }
          value={value}
          disabled={disabled}
          onChange={(n) => onChange(values.map((v, j) => (j === i ? n : v)))}
        />
      ))}
    </div>
  );
}
export function Section({
  title,
  children,
  open = false,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="property-section" open={open || undefined}>
      <summary>{title}</summary>
      <div>{children}</div>
    </details>
  );
}
