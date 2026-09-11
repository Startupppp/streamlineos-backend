const DEFAULT_HR_READ_LIMIT = 100;

/** Keep service-level reads bounded even when a caller bypasses DTO validation. */
export function boundHrReadLimit(value: number, fallback = DEFAULT_HR_READ_LIMIT): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), fallback));
}

/** One page of an internal keyset walk. Never larger than the hard read cap. */
export const HR_SCAN_PAGE = DEFAULT_HR_READ_LIMIT;

/** Ceiling on pages a single keyset walk may take, so a runaway predicate still terminates. */
export const HR_SCAN_MAX_PAGES = 200;
