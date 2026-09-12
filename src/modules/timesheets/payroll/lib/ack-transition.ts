import type { AckExportInput } from "../dto/payroll.schemas";

export type AckStatus = AckExportInput["status"];

/** The statuses a payroll system reports once it has finished with an export. */
const SETTLED: ReadonlySet<string> = new Set<AckStatus>(["ACCEPTED", "REJECTED", "FAILED"]);

/**
 * Why an acknowledgement may not be recorded over the export's current one, or
 * `null` when it may.
 *
 * An export is acknowledged repeatedly as the payroll system works through it —
 * RECEIVED, then ACCEPTED, or REJECTED and later ACCEPTED after a fix — so most
 * moves are legitimate. Two are not. Recording the status it already has is a
 * retry or a double submit, and recording it again would emit a second handoff
 * event for one fact. And a settled export cannot become merely RECEIVED again:
 * the payroll side has already answered, and "received" after "accepted" would
 * read to the handoff as the answer being withdrawn.
 */
export function ackTransitionRefusal(current: string | null, next: AckStatus): string | null {
  if (current === next) return `Export is already acknowledged as ${next}`;
  if (next === "RECEIVED" && current !== null && SETTLED.has(current))
    return `Export was already ${current}; it cannot go back to RECEIVED`;
  return null;
}
