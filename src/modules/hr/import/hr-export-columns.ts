import { getTableColumns } from "drizzle-orm";
import { attendance, assets, leaveBalances, documents } from "../../../db/schema";
import type { HrImportEntity } from "./dto/import-job.dto";

/**
 * The columns an entity's CSV export carries, independent of whether the export
 * found any rows.
 *
 * `GET /hr/export/:entity` built its header from `Object.keys(rows[0] ?? {})`.
 * That is correct for a non-empty page and silently wrong for an empty one: the
 * header list came out empty, `toCsv` produced an empty string, and the browser
 * saved a 0-byte file that looked like a successful download. QA saw it twice —
 * once on an org with no assets and again on one with eight, where the second
 * 0-byte file came from the request being blocked rather than from the rows.
 * Deriving the header from the table means an empty export is a header-only CSV
 * that states its own shape, and a blocked request stays visibly an error.
 *
 * `exportEntity` selects whole rows, so the table's column list is exactly the
 * key set the serializer would have discovered. Keeping the two in one place is
 * what stops them drifting the next time a column is added.
 */
const EXPORT_TABLES = {
  attendance,
  assets,
  leave_balances: leaveBalances,
  document_metadata: documents,
} as const;

export function exportColumnsOf(entity: HrImportEntity): string[] {
  // `employees` is refused by `exportEntity` — it has its own async job route
  // with a curated, permission-filtered column set — so it has no entry here.
  const table = EXPORT_TABLES[entity as keyof typeof EXPORT_TABLES];
  if (!table) return [];
  return Object.keys(getTableColumns(table));
}
