/** @jsxImportSource preact */
import type { ComponentChildren, JSX } from 'preact'
import { useRef } from 'preact/hooks'
import { cx, uid } from './util'

interface FieldProps {
  label?: ComponentChildren
  hint?: ComponentChildren
  error?: ComponentChildren
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: FieldProps & { id: string; children: ComponentChildren }) {
  return (
    <div class={cx('bh-field', error ? 'bh-field--error' : false)}>
      {label && (
        <label class="bh-field__label" for={id}>
          {label}
        </label>
      )}
      {children}
      {error ? (
        <div class="bh-field__error" role="alert">
          {error}
        </div>
      ) : (
        hint && <div class="bh-field__hint">{hint}</div>
      )}
    </div>
  )
}

export interface InputProps
  extends FieldProps,
    Omit<JSX.HTMLAttributes<HTMLInputElement>, 'label' | 'onInput' | 'value'> {
  value?: string | number
  type?: string
  placeholder?: string
  disabled?: boolean
  mono?: boolean
  onValue?: (value: string) => void
}

export function Input({
  label,
  hint,
  error,
  id,
  mono,
  onValue,
  class: className,
  ...rest
}: InputProps) {
  const fieldId = useRef((id as string | undefined) ?? uid('bh-input')).current
  return (
    <Field id={fieldId} label={label} hint={hint} error={error}>
      <input
        {...rest}
        id={fieldId}
        aria-invalid={error ? true : undefined}
        class={cx('bh-input', mono && 'bh-mono', className as string)}
        onInput={(e) => onValue?.((e.currentTarget as HTMLInputElement).value)}
      />
    </Field>
  )
}

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends FieldProps {
  value: string
  options: SelectOption[]
  onValue: (value: string) => void
  id?: string
  disabled?: boolean
  class?: string
}

export function Select({
  label,
  hint,
  error,
  id,
  value,
  options,
  onValue,
  disabled,
  class: className,
}: SelectProps) {
  const fieldId = useRef(id ?? uid('bh-select')).current
  return (
    <Field id={fieldId} label={label} hint={hint} error={error}>
      <select
        id={fieldId}
        value={value}
        disabled={disabled}
        class={cx('bh-select', className)}
        onChange={(e) => onValue((e.currentTarget as HTMLSelectElement).value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  )
}

export interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ComponentChildren
  disabled?: boolean
  class?: string
}

/** Switch-style boolean toggle (role="switch"). */
export function Toggle({ checked, onChange, label, disabled, class: className }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      class={cx('bh-toggle', checked && 'bh-toggle--on', className)}
      onClick={() => onChange(!checked)}
    >
      <span class="bh-toggle__track" aria-hidden="true">
        <span class="bh-toggle__thumb" />
      </span>
      <span class="bh-toggle__label">{label}</span>
    </button>
  )
}
