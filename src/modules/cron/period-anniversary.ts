export type BillingCycle = "monthly" | "annual";

/**
 * Computes the end of the next billing period, clamping to the last day of the
 * target month when the start day does not exist there.
 *
 * JavaScript's `Date.setMonth(n)` overflows into the following month when the
 * start day exceeds the target month's length (e.g. 31 Jan + 1 month → 3 Mar),
 * which would expire an annual subscription after one month for any customer
 * whose billing anchor is on day 29–31. This helper clamps to last-day-of-month
 * instead.
 *
 * Examples:
 *   nextPeriodEnd(Jan 31, "monthly") = Feb 28 (or 29 in a leap year)
 *   nextPeriodEnd(Feb 29, "annual")  = Feb 28 (non-leap target year)
 *   nextPeriodEnd(Mar 31, "monthly") = Apr 30
 *   nextPeriodEnd(Dec 31, "monthly") = Jan 31 (next year)
 */
export function nextPeriodEnd(start: Date, cycle: BillingCycle): Date {
  const monthsToAdd = cycle === "monthly" ? 1 : 12;

  const srcYear = start.getFullYear();
  const srcMonth = start.getMonth();
  const srcDay = start.getDate();

  const rawTargetMonth = srcMonth + monthsToAdd;
  const targetYear = srcYear + Math.floor(rawTargetMonth / 12);
  const targetMonth = rawTargetMonth % 12;

  const lastDayOfTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  const targetDay = Math.min(srcDay, lastDayOfTargetMonth);

  return new Date(
    targetYear,
    targetMonth,
    targetDay,
    start.getHours(),
    start.getMinutes(),
    start.getSeconds(),
    start.getMilliseconds(),
  );
}
