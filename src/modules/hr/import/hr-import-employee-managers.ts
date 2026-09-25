import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { hrImportRows } from "../../../db/schema/hr/import-jobs";
import type { ReportingActor } from "../../directory/reporting-line.types";
import type { ReportingManagerFallbackResolver } from "../../directory/reporting-manager-fallback.resolver";
import { managersFirst } from "../directory/bulk-onboarding/bulk-onboarding-graph";
import {
  PRIMARY_MANAGER_COLUMN,
  SECONDARY_MANAGER_COLUMNS,
  normaliseManagerColumns,
} from "../directory/reporting-manager-columns";
import type { HrImportEntity } from "./dto/import-job.dto";
import type { RowValidationResult } from "./schemas/entity-row-schemas";

/** The create cap on `hr_import_rows` per job (`createImportJobSchema`). */
const IMPORT_ROW_CAP = 5000;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * HRM-15 §4.22: the staged employee import reads the same manager columns as bulk onboarding,
 * through the one normaliser. A row whose headers disagree keeps a `managerColumnConflict` marker
 * the row schema rejects, so it becomes an ordinary row error at the right row number.
 */
export function normaliseEmployeeImportRows(rows: ReadonlyArray<Record<string, unknown>>): {
  rows: Array<Record<string, unknown>>;
  legacyHeaderRows: number;
} {
  let legacyHeaderRows = 0;
  const normalised = rows.map((row) => {
    const result = normaliseManagerColumns(row);
    if (!result.ok) return { ...row, managerColumnConflict: result.conflictingColumns.join(", ") };
    if (result.legacyHeader !== null) legacyHeaderRows += 1;
    const out: Record<string, unknown> = { ...result.row };
    for (const key of [PRIMARY_MANAGER_COLUMN, ...SECONDARY_MANAGER_COLUMNS]) if (out[key] === null) delete out[key];
    return out;
  });
  return { rows: normalised, legacyHeaderRows };
}

/**
 * D2 for the staged import: a NEW employee whose primary manager is blank (and who is not a
 * top-level row) gets the policy's fallback, resolved once for the whole file and written onto
 * the stored payload so the preview shows who it will be. An existing employee's blank manager
 * means "no change" and is left alone. Returns the rows the policy could not place.
 */
export async function resolveImportFallbacks(
  resolver: Pick<ReportingManagerFallbackResolver, "resolveMany">,
  actor: ReportingActor,
  entity: HrImportEntity,
  rows: readonly RowValidationResult[],
): Promise<{ valid: RowValidationResult[]; errors: RowValidationResult[] }> {
  const failures = entity === "employees" ? await fallbackFailures(resolver, actor, rows) : new Map<number, string>();
  return {
    valid: rows.filter((row) => !failures.has(row.rowNumber)),
    errors: rows.flatMap((row) => {
      const error = failures.get(row.rowNumber);
      return error === undefined ? [] : [{ ...row, status: "error" as const, error }];
    }),
  };
}

async function fallbackFailures(
  resolver: Pick<ReportingManagerFallbackResolver, "resolveMany">,
  actor: ReportingActor,
  rows: readonly RowValidationResult[],
): Promise<Map<number, string>> {
  const needing = rows.filter(
    (row) =>
      row.payload.resolvedExistingEmployee !== true &&
      text(row.payload.primaryManagerEmail) === "" &&
      text(row.payload.topLevelRoleReason) === "",
  );
  const failures = new Map<number, string>();
  if (needing.length === 0) return failures;
  const results = await resolver.resolveMany(
    actor.orgId,
    actor,
    needing.map((row) => ({ key: row.rowNumber, employeeEmail: text(row.payload.email) })),
  );
  const byRow = new Map(needing.map((row) => [row.rowNumber, row]));
  for (const result of results) {
    const row = byRow.get(result.key);
    if (!row) continue;
    if (!result.ok || result.managerUserId === null) {
      failures.set(result.key, result.ok ? "No reporting manager could be resolved." : result.message);
      continue;
    }
    row.payload.resolvedPrimaryManagerUserId = result.managerUserId;
    row.payload.primaryManagerResolution = result.resolution;
  }
  return failures;
}

/**
 * The order a job's valid rows commit in. By row number, except that for employees a row whose
 * primary manager is another row of the file commits after that row, so the manager exists when
 * the relationship is written. Bounded by the job's row cap.
 */
export async function importCommitOrder(tx: DbOrTx, jobId: string, entity: HrImportEntity): Promise<string[]> {
  const rows = await tx
    .select({ id: hrImportRows.id, rowNumber: hrImportRows.rowNumber, payload: hrImportRows.payload })
    .from(hrImportRows)
    .where(and(eq(hrImportRows.jobId, jobId), eq(hrImportRows.status, "valid")))
    .orderBy(asc(hrImportRows.rowNumber))
    .limit(IMPORT_ROW_CAP);
  if (entity !== "employees") return rows.map((row) => row.id);

  const idByEmail = new Map(rows.map((row) => [text(row.payload.email), row.id]));
  const edges = rows.flatMap((row) => {
    const managerEmail = text(row.payload.primaryManagerEmail);
    return managerEmail !== "" && idByEmail.has(managerEmail)
      ? [{ row: row.rowNumber, email: text(row.payload.email), managerEmail }]
      : [];
  });
  return managersFirst(rows.map((row) => text(row.payload.email)), edges).flatMap((email) => {
    const id = idByEmail.get(email);
    return id ? [id] : [];
  });
}

/** One batch of a job's valid rows, returned in the order `importCommitOrder` gave their ids. */
export async function readImportRowsInOrder(tx: DbOrTx, jobId: string, ids: readonly string[]) {
  const fetched = await tx
    .select()
    .from(hrImportRows)
    .where(and(eq(hrImportRows.jobId, jobId), eq(hrImportRows.status, "valid"), inArray(hrImportRows.id, [...ids])))
    .limit(ids.length);
  const byId = new Map(fetched.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}
