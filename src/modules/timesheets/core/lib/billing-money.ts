/**
 * Rounding, in the one place both halves of billing agree on it.
 *
 * Timesheet money is `decimal(x,2)` in major units, not the integer minor units
 * the GL kernel uses, so an amount reaches JavaScript as a string and leaves as
 * a number that has to be re-rounded before it is written back. Shared so the
 * quote a customer is shown and the amount the export writes cannot round
 * differently.
 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
