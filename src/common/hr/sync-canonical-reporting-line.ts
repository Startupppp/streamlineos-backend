import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { hrReportingLines, type ReportingLineSource } from "../../db/schema";
import type { DbOrTx } from "../rbac/access-invalidate";

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

interface StoredLine {
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

type NewLine = Omit<typeof hrReportingLines.$inferInsert, "orgId">;

interface Carve {
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

function covers(line: StoredLine, window: LineWindow): boolean {
  const to = window.to ?? OPEN_ENDED;
  return line.effectiveFrom <= window.from && (line.effectiveTo === OPEN_ENDED || (to !== OPEN_ENDED && line.effectiveTo >= to));
}

/**
 * Serialises every reporting-line write in one organisation for the rest of the transaction, so a
 * cycle check and the write it guards see the same hierarchy. Re-entrant within a transaction.
 */
export async function lockReportingLines(db: DbOrTx, orgId: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`hr_reporting_lines:${orgId}`}))`);
}

/**
 * Removes `window` from the timeline of `lines`, never producing an end before a start and never
 * deleting history: a line that began before the window is closed the day before it; a line that
 * begins inside the window never took effect and moves to `hr_reporting_lines_superseded`; the part
 * of any line that runs past a bounded window is re-opened as a continuation the day after it.
 */
function carve(lines: readonly StoredLine[], window: LineWindow, provenance: LineProvenance): Carve {
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

async function linesTouching(db: DbOrTx, orgId: string, employmentIds: readonly number[], primary: boolean, from: string): Promise<StoredLine[]> {
  if (employmentIds.length === 0) return [];
  return db
    .select({
      id: hrReportingLines.id,
      employmentId: hrReportingLines.employmentId,
      managerEmploymentId: hrReportingLines.managerEmploymentId,
      lineType: hrReportingLines.lineType,
      effectiveFrom: hrReportingLines.effectiveFrom,
      effectiveTo: hrReportingLines.effectiveTo,
      source: hrReportingLines.source,
      changeReason: hrReportingLines.changeReason,
      relationshipLabel: hrReportingLines.relationshipLabel,
      bulkJobId: hrReportingLines.bulkJobId,
      requestId: hrReportingLines.requestId,
    })
    .from(hrReportingLines)
    .where(
      and(
        eq(hrReportingLines.orgId, orgId),
        inArray(hrReportingLines.employmentId, [...employmentIds]),
        primary ? eq(hrReportingLines.lineType, "primary") : ne(hrReportingLines.lineType, "primary"),
        sql`${hrReportingLines.effectiveTo} >= ${from}::date`,
      ),
    )
    .orderBy(hrReportingLines.employmentId, hrReportingLines.effectiveFrom)
    .for("update");
}

async function applyCarve(db: DbOrTx, orgId: string, carved: Carve, from: string, supersededBy: string | null): Promise<void> {
  if (carved.archiveIds.length > 0)
    await db.execute(sql`
      WITH moved AS (
        INSERT INTO hr_reporting_lines_superseded (
          org_id, line_id, employment_id, manager_employment_id, line_type, effective_from, effective_to,
          source, change_reason, relationship_label, bulk_job_id, request_id, created_by, created_at,
          superseded_reason, superseded_by
        )
        SELECT org_id, id, employment_id, manager_employment_id, line_type, effective_from, effective_to,
               source, change_reason, relationship_label, bulk_job_id, request_id, created_by, created_at,
               'REPLACED', ${supersededBy}
        FROM hr_reporting_lines
        WHERE org_id = ${orgId} AND id = ANY(${sql.param(carved.archiveIds)}::int[])
        RETURNING line_id
      )
      DELETE FROM hr_reporting_lines
      WHERE org_id = ${orgId} AND id IN (SELECT line_id FROM moved)
    `);
  if (carved.closeIds.length > 0)
    await db
      .update(hrReportingLines)
      .set({ effectiveTo: dayBefore(from), updatedAt: new Date() })
      .where(and(eq(hrReportingLines.orgId, orgId), inArray(hrReportingLines.id, carved.closeIds)));
}

async function insertLines(db: DbOrTx, orgId: string, lines: readonly NewLine[]): Promise<Array<{ id: number; employmentId: number; managerEmploymentId: number; effectiveFrom: string }>> {
  if (lines.length === 0) return [];
  return db
    .insert(hrReportingLines)
    .values(lines.map((line) => ({ ...line, orgId })))
    .returning({
      id: hrReportingLines.id,
      employmentId: hrReportingLines.employmentId,
      managerEmploymentId: hrReportingLines.managerEmploymentId,
      effectiveFrom: hrReportingLines.effectiveFrom,
    });
}

function newLine(employmentId: number, managerEmploymentId: number, lineType: NewLine["lineType"], window: LineWindow, provenance: LineProvenance, label: string | null): NewLine {
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

/**
 * THE primary-line writer. Every assignment in the batch shares one window and provenance; the
 * statement count is constant in the batch size (one read, one archive, one close, one insert).
 * `managerEmploymentId: null` clears the primary manager from `window.from`.
 */
export async function writePrimaryLines(
  db: DbOrTx,
  orgId: string,
  assignments: ReadonlyArray<{ employmentId: number; managerEmploymentId: number | null }>,
  window: LineWindow,
  provenance: LineProvenance,
): Promise<Map<number, PrimaryWriteResult>> {
  const results = new Map<number, PrimaryWriteResult>();
  const wanted = new Map<number, number | null>();
  for (const assignment of assignments) wanted.set(assignment.employmentId, assignment.managerEmploymentId);
  if (wanted.size === 0) return results;

  await lockReportingLines(db, orgId);
  const existing = await linesTouching(db, orgId, [...wanted.keys()], true, window.from);
  const byEmployment = new Map<number, StoredLine[]>();
  for (const line of existing) byEmployment.set(line.employmentId, [...(byEmployment.get(line.employmentId) ?? []), line]);

  const merged: Carve = { archiveIds: [], closeIds: [], continuations: [] };
  const inserts: NewLine[] = [];
  const previousLine = new Map<number, number | null>();
  for (const [employmentId, managerEmploymentId] of wanted) {
    const lines = byEmployment.get(employmentId) ?? [];
    const current = lines.find((line) => line.effectiveFrom <= window.from) ?? null;
    previousLine.set(employmentId, current?.id ?? null);
    if (managerEmploymentId !== null && current && current.managerEmploymentId === managerEmploymentId && covers(current, window)) {
      results.set(employmentId, { status: "unchanged", lineId: current.id, managerEmploymentId });
      continue;
    }
    const carved = carve(lines, window, provenance);
    merged.archiveIds.push(...carved.archiveIds);
    merged.closeIds.push(...carved.closeIds);
    merged.continuations.push(...carved.continuations);
    if (managerEmploymentId === null) results.set(employmentId, { status: "cleared", previousLineId: current?.id ?? null });
    else inserts.push(newLine(employmentId, managerEmploymentId, "primary", window, provenance, null));
  }

  await applyCarve(db, orgId, merged, window.from, provenance.createdBy);
  const written = await insertLines(db, orgId, [...inserts, ...merged.continuations]);
  for (const row of written) {
    if (row.effectiveFrom !== window.from) continue;
    results.set(row.employmentId, {
      status: "written",
      lineId: row.id,
      previousLineId: previousLine.get(row.employmentId) ?? null,
      managerEmploymentId: row.managerEmploymentId,
    });
  }
  return results;
}

/**
 * THE secondary-line writer: from `from` onward the employee's secondary managers are `desired`. A
 * manager already on record (open-ended, whether in force or scheduled) with the same label keeps
 * their lines untouched; everyone not in the set is ended (closed or superseded) and the missing
 * ones start a new `matrix` line.
 */
export async function writeSecondaryLines(
  db: DbOrTx,
  orgId: string,
  employmentId: number,
  desired: ReadonlyArray<{ managerEmploymentId: number; label: string | null }>,
  from: string,
  provenance: LineProvenance,
): Promise<SecondaryWriteResult> {
  await lockReportingLines(db, orgId);
  const existing = await linesTouching(db, orgId, [employmentId], false, from);
  const window: LineWindow = { from };
  const wantedLabel = new Map(desired.map((entry) => [entry.managerEmploymentId, entry.label]));

  const merged: Carve = { archiveIds: [], closeIds: [], continuations: [] };
  const kept: number[] = [];
  const keptManagers = new Set<number>();
  const byManager = new Map<number, StoredLine[]>();
  for (const line of existing) byManager.set(line.managerEmploymentId, [...(byManager.get(line.managerEmploymentId) ?? []), line]);

  for (const [managerEmploymentId, lines] of byManager) {
    const label = wantedLabel.get(managerEmploymentId);
    // A manager the set names again keeps every line they already have, current or scheduled, so a
    // future start date survives an edit; only a label change replaces them from `from`.
    if (label !== undefined && lines.every((line) => line.relationshipLabel === label) && lines.some((line) => line.effectiveTo === OPEN_ENDED)) {
      kept.push(...lines.map((line) => line.id));
      keptManagers.add(managerEmploymentId);
      continue;
    }
    const carved = carve(lines, window, provenance);
    merged.archiveIds.push(...carved.archiveIds);
    merged.closeIds.push(...carved.closeIds);
  }

  await applyCarve(db, orgId, merged, from, provenance.createdBy);
  const added = await insertLines(
    db,
    orgId,
    desired
      .filter((entry) => !keptManagers.has(entry.managerEmploymentId))
      .map((entry) => newLine(employmentId, entry.managerEmploymentId, "matrix", window, provenance, entry.label)),
  );
  return {
    addedLineIds: added.map((row) => row.id),
    endedLineIds: [...merged.closeIds, ...merged.archiveIds],
    keptLineIds: kept,
  };
}
