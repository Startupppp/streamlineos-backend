/**
 * The arithmetic behind the recruiting dashboard.
 *
 * Pure, because every number here is one somebody will make a decision with and
 * every one of them has a degenerate case: a funnel stage with nobody in it, a
 * source that produced one hire from one applicant, a job that has been open
 * for three days. A rate computed carelessly reports 0%, 100% or NaN in exactly
 * those cases, and all three read as facts.
 */

export interface FunnelStage {
  stage: string;
  count: number;
}

export interface FunnelStep extends FunnelStage {
  /**
   * Percentage of the previous stage that reached this one, or null for the
   * first stage and for any stage whose predecessor was empty.
   *
   * Null rather than zero. "Nobody converted" and "there was nobody to convert"
   * are different facts, and a dashboard that renders the second as 0% tells a
   * recruiter their screening is broken when they simply have no applicants.
   */
  conversionFromPrevious: number | null;
  /** Percentage of the very first stage, on the same terms. */
  conversionFromTop: number | null;
}

function rate(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

export function buildFunnel(stages: readonly FunnelStage[]): FunnelStep[] {
  const top = stages[0]?.count ?? 0;
  return stages.map((stage, index) => ({
    ...stage,
    conversionFromPrevious: index === 0 ? null : rate(stage.count, stages[index - 1]?.count ?? 0),
    conversionFromTop: index === 0 ? null : rate(stage.count, top),
  }));
}

export interface Percentiles {
  count: number;
  median: number | null;
  p90: number | null;
  mean: number | null;
}

/**
 * Time-to-fill and friends, reported as a median rather than a mean alone.
 *
 * One requisition that stayed open for a year drags a mean far enough to make
 * every planning number wrong, and hiring distributions always have that
 * requisition. The mean is kept beside it because the gap between the two is
 * itself the signal that one exists.
 *
 * The median of an even-sized sample is the lower of the two middle values, not
 * their average: these are whole days, and "22.5 days to fill" is a number no
 * real requisition took.
 */
export function percentiles(values: readonly number[]): Percentiles {
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, median: null, p90: null, mean: null };

  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? null;

  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    median: at(0.5),
    p90: at(0.9),
    mean: Math.round((sum / sorted.length) * 10) / 10,
  };
}

export interface SourcePerformance {
  source: string;
  applicants: number;
  hires: number;
  /** Null when nobody applied from this source, for the reason above. */
  hireRate: number | null;
}

export function sourcePerformance(
  rows: readonly { source: string; applicants: number; hires: number }[],
): SourcePerformance[] {
  return rows
    .map((row) => ({ ...row, hireRate: rate(row.hires, row.applicants) }))
    /*
      Sorted by hires and then by applicants, not by rate. A source with one
      applicant and one hire has a 100% rate and tells nobody anything; putting
      it above a source that produced twenty hires would make the table
      actively misleading at a glance.
    */
    .sort((a, b) => b.hires - a.hires || b.applicants - a.applicants);
}

/**
 * Offer accept rate, over offers that were actually answered.
 *
 * Outstanding offers are excluded from the denominator rather than counted as
 * declines. Including them makes the rate fall every time a new offer goes out
 * and rise when it is accepted, which reads as volatility in candidate
 * behaviour that is really just the passage of time.
 */
export function offerAcceptRate(accepted: number, declined: number): number | null {
  return rate(accepted, accepted + declined);
}

/**
 * Turns rows into CSV.
 *
 * Quotes every field rather than only the ones that need it, and doubles inner
 * quotes. The interesting case is a leading `=`, `+`, `-` or `@`: a spreadsheet
 * treats those as formulas, so a candidate whose name or a source label starts
 * with one becomes executable content in Excel. Prefixing with a single quote
 * inside the quoted field neutralises it without changing what a person reads.
 */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
): string {
  const cell = (value: string | number | null): string => {
    const text = value === null ? "" : String(value);
    const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${guarded.replace(/"/g, '""')}"`;
  };
  const lines = [headers.map(cell).join(","), ...rows.map((row) => row.map(cell).join(","))];
  return lines.join("\r\n");
}
