import type { hrReportingLines, ReportingLineSource } from "../../db/schema";

export interface LineProvenance {
  source: ReportingLineSource;
  reason?: string | null;
  bulkJobId?: string | null;
  requestId?: string | null;
  createdBy: string | null;
}

export interface LineWindow {
  from: string;
  /** Inclusive last day; omitted or null means open-ended. */
  to?: string | null;
}

export type PrimaryWriteResult =
  | { status: "written"; lineId: number; previousLineId: number | null; managerEmploymentId: number }
  | { status: "unchanged"; lineId: number; managerEmploymentId: number }
  | { status: "cleared"; previousLineId: number | null };

export interface SecondaryWriteResult {
  addedLineIds: number[];
  endedLineIds: number[];
  keptLineIds: number[];
}

export const OPEN_ENDED = "infinity";

export interface StoredLine {
  id: number;
  employmentId: number;
  managerEmploymentId: number;
  lineType: "primary" | "matrix" | "dotted";
  effectiveFrom: string;
  effectiveTo: string;
  source: ReportingLineSource;
  changeReason: string | null;
  relationshipLabel: string | null;
  bulkJobId: string | null;
  requestId: string | null;
}

export type NewLine = Omit<typeof hrReportingLines.$inferInsert, "orgId">;

export interface Carve {
  archiveIds: number[];
  closeIds: number[];
  continuations: NewLine[];
}

export function dayBefore(isoDate: string): string {
  return shiftDay(isoDate, -1);
}

export function dayAfter(isoDate: string): string {
  return shiftDay(isoDate, 1);
}

function shiftDay(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day) return isoDate;
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function endsAfter(effectiveTo: string, day: string): boolean {
  return effectiveTo === OPEN_ENDED || effectiveTo > day;
}

export function covers(line: StoredLine, window: LineWindow): boolean {
  const to = window.to ?? OPEN_ENDED;
  return line.effectiveFrom <= window.from && (line.effectiveTo === OPEN_ENDED || (to !== OPEN_ENDED && line.effectiveTo >= to));
}

/**
 * Removes `window` from the timeline of `lines`, never producing an end before a start and never
 * deleting history: a line that began before the window is closed the day before it; a line that
 * begins inside the window never took effect and moves to `hr_reporting_lines_superseded`; the part
 * of any line that runs past a bounded window is re-opened as a continuation the day after it.
 */
export function carve(lines: readonly StoredLine[], window: LineWindow, provenance: LineProvenance): Carve {
  const windowTo = window.to ?? OPEN_ENDED;
  const result: Carve = { archiveIds: [], closeIds: [], continuations: [] };
  for (const line of lines) {
    const overlaps = !(line.effectiveTo !== OPEN_ENDED && line.effectiveTo < window.from) && (windowTo === OPEN_ENDED || line.effectiveFrom <= windowTo);
    if (!overlaps) continue;
    if (line.effectiveFrom < window.from) result.closeIds.push(line.id);
    else result.archiveIds.push(line.id);
    if (windowTo !== OPEN_ENDED && endsAfter(line.effectiveTo, windowTo))
      result.continuations.push({
        employmentId: line.employmentId,
        managerEmploymentId: line.managerEmploymentId,
        lineType: line.lineType,
        effectiveFrom: dayAfter(windowTo),
        effectiveTo: line.effectiveTo,
        source: line.source,
        changeReason: line.changeReason,
        relationshipLabel: line.relationshipLabel,
        bulkJobId: line.bulkJobId,
        requestId: line.requestId,
        createdBy: provenance.createdBy,
      });
  }
  return result;
}

export function newLine(employmentId: number, managerEmploymentId: number, lineType: NewLine["lineType"], window: LineWindow, provenance: LineProvenance, label: string | null): NewLine {
  return {
    employmentId,
    managerEmploymentId,
    lineType,
    effectiveFrom: window.from,
    ...(window.to ? { effectiveTo: window.to } : {}),
    source: provenance.source,
    changeReason: provenance.reason ?? null,
    relationshipLabel: label,
    bulkJobId: provenance.bulkJobId ?? null,
    requestId: provenance.requestId ?? null,
    createdBy: provenance.createdBy,
  };
}
