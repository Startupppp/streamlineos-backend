/**
 * Pure aging / SLA helpers for HR service delivery inbox (Phase 9).
 */

export type AgingBucket = "fresh" | "watch" | "overdue" | "critical";

export interface AgingResult {
  ageHours: number;
  ageDays: number;
  bucket: AgingBucket;
  slaBreached: boolean;
}

/**
 * Classify open work item age for ops prioritization.
 * - fresh: < 24h
 * - watch: 1–3 days
 * - overdue: 3–7 days (or past slaDueAt)
 * - critical: > 7 days (or severely past SLA)
 */
export function classifyAging(
  createdAt: Date | string,
  now: Date = new Date(),
  slaDueAt?: Date | string | null,
): AgingResult {
  const created = typeof createdAt === "string" ? new Date(createdAt) : createdAt;
  const ageMs = Math.max(0, now.getTime() - created.getTime());
  const ageHours = ageMs / (1000 * 60 * 60);
  const ageDays = ageHours / 24;

  let slaBreached = false;
  if (slaDueAt) {
    const due = typeof slaDueAt === "string" ? new Date(slaDueAt) : slaDueAt;
    if (!Number.isNaN(due.getTime()) && now.getTime() > due.getTime()) {
      slaBreached = true;
    }
  }

  let bucket: AgingBucket;
  if (slaBreached && ageDays > 7) bucket = "critical";
  else if (slaBreached || ageDays >= 3) bucket = ageDays >= 7 ? "critical" : "overdue";
  else if (ageDays >= 1) bucket = "watch";
  else bucket = "fresh";

  return {
    ageHours: Math.round(ageHours * 10) / 10,
    ageDays: Math.round(ageDays * 10) / 10,
    bucket,
    slaBreached,
  };
}

export function sortByUrgency<T extends { aging: AgingResult; severityRank: number }>(
  items: T[],
): T[] {
  const bucketRank: Record<AgingBucket, number> = {
    critical: 0,
    overdue: 1,
    watch: 2,
    fresh: 3,
  };
  return [...items].sort((a, b) => {
    const br = bucketRank[a.aging.bucket] - bucketRank[b.aging.bucket];
    if (br !== 0) return br;
    const sr = b.severityRank - a.severityRank;
    if (sr !== 0) return sr;
    return b.aging.ageHours - a.aging.ageHours;
  });
}

export function severityRank(kind: string, severity?: string | null): number {
  const s = (severity ?? "").toLowerCase();
  if (s === "critical" || s === "urgent") return 4;
  if (s === "high") return 3;
  if (s === "medium" || s === "normal") return 2;
  if (s === "low") return 1;
  // helpdesk ticket_priority enum
  if (kind === "helpdesk") {
    if (s === "urgent") return 4;
    if (s === "high") return 3;
    if (s === "medium") return 2;
    if (s === "low") return 1;
  }
  return 1;
}
