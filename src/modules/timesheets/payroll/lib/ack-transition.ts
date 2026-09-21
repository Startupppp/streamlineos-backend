import type { AckExportInput } from "../dto/payroll.schemas";

export type AckStatus = AckExportInput["status"];

const SETTLED: ReadonlySet<string> = new Set<AckStatus>(["ACCEPTED", "REJECTED", "FAILED"]);

export function ackTransitionRefusal(current: string | null, next: AckStatus): string | null {
  if (current === next) return `Export is already acknowledged as ${next}`;
  if (next === "RECEIVED" && current !== null && SETTLED.has(current))
    return `Export was already ${current}; it cannot go back to RECEIVED`;
  return null;
}
