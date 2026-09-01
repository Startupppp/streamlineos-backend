const DEFAULT_HR_READ_LIMIT = 100;

/** Keep service-level reads bounded even when a caller bypasses DTO validation. */
export function boundHrReadLimit(value: number, fallback = DEFAULT_HR_READ_LIMIT): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), fallback));
}
