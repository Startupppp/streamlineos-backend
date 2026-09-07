export function assertOneOf<T extends string>(
  values: readonly T[],
  value: string,
  label: string,
): T {
  for (const candidate of values) {
    if (candidate === value) return candidate;
  }
  throw new Error(`Invalid ${label} value: ${value}`);
}
