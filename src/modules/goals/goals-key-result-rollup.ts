export interface KeyResultRollup {
  target: string | null;
  current: string | null;
}

const SCALE = 100;

function toScaled(value: string): number {
  const parsed = parseFloat(value);
  if (Number.isNaN(parsed)) return 0;
  return Math.round(parsed * SCALE);
}

function fromScaled(value: number): string {
  return (value / SCALE).toFixed(2);
}

export function rollUpKeyResultValues(
  keyResults: ReadonlyArray<{ targetValue: string; currentValue: string }>,
): KeyResultRollup {
  if (keyResults.length === 0) return { target: null, current: null };
  let target = 0;
  let current = 0;
  for (const keyResult of keyResults) {
    target += toScaled(keyResult.targetValue);
    current += toScaled(keyResult.currentValue);
  }
  return { target: fromScaled(target), current: fromScaled(current) };
}

export function normalizeRolledUpValue(value: string | null): string | null {
  if (value === null) return null;
  return fromScaled(toScaled(value));
}
