import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { hrReportingLines } from "../../db/schema";
import type { DbOrTx } from "../rbac/access-invalidate";
import {
  OPEN_ENDED,
  carve,
  covers,
  dayBefore,
  newLine,
  type Carve,
  type LineProvenance,
  type LineWindow,
  type NewLine,
  type PrimaryWriteResult,
  type SecondaryWriteResult,
  type StoredLine,
} from "./reporting-line-timeline";

/**
 * Serialises every reporting-line write in one organisation for the rest of the transaction, so a
 * cycle check and the write it guards see the same hierarchy. Re-entrant within a transaction.
 */
export async function lockReportingLines(db: DbOrTx, orgId: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`hr_reporting_lines:${orgId}`}))`);
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
