import { useState } from 'react';
import { Input } from '@0xnullai/ui';

/**
 * A numeric input that only commits on blur or Enter.
 *
 * Committing on every keystroke makes intermediate states real: typing "20"
 * over "5" passes through 205 on the way, and these fields feed sensor
 * thresholds. Escape restores the last committed value.
 *
 * It lived in SafetyTab.tsx until that tab was deleted — Agent's device
 * safety moved to the shell, leaving the tab unreachable and this the only
 * live export in a 654-line file.
 */
export function ConfigNumberField({
  id,
  value,
  min,
  max,
  onChange,
  allowDecimal = false,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** Allows one decimal point (e.g. kPa thresholds) instead of the default integer-only input. */
  allowDecimal?: boolean;
}) {
  const [draftValue, setDraftValue] = useState(String(value));
  const [prevValue, setPrevValue] = useState(value);

  if (prevValue !== value) {
    setPrevValue(value);
    setDraftValue(String(value));
  }

  const sanitize = (raw: string): string =>
    allowDecimal ? raw.replace(/[^0-9.]+/g, '').replace(/(\..*)\./g, '$1') : raw.replace(/\D+/g, '');

  function commit(nextDraftValue: string) {
    const sanitized = sanitize(nextDraftValue);
    const nextValue = sanitized ? Math.max(min, Math.min(max, Number(sanitized))) : min;

    setDraftValue(String(nextValue));
    if (nextValue !== value) {
      onChange(nextValue);
    }
  }

  return (
    <Input
      id={id}
      type="text"
      inputMode={allowDecimal ? 'decimal' : 'numeric'}
      pattern={allowDecimal ? undefined : '[0-9]*'}
      value={draftValue}
      onChange={(event) => {
        setDraftValue(sanitize(event.target.value));
      }}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit(event.currentTarget.value);
          event.currentTarget.blur();
        }
        if (event.key === 'Escape') {
          setDraftValue(String(value));
          event.currentTarget.blur();
        }
      }}
      className="text-right tabular-nums"
    />
  );
}
