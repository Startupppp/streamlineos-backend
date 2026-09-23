import { and, eq, lt, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

export type DescKeysetPosition = { readonly id: number; readonly t: string | null };

export function descKeyset(
  sortColumn: PgColumn,
  idColumn: PgColumn,
  position: DescKeysetPosition | null,
): SQL | undefined {
  if (position === null) return undefined;
  if (!Number.isSafeInteger(position.id)) return undefined;
  if (position.t === null) return lt(idColumn, position.id);
  const at = new Date(position.t);
  if (Number.isNaN(at.getTime())) return lt(idColumn, position.id);
  return or(
    lt(sortColumn, at),
    and(eq(sortColumn, at), lt(idColumn, position.id)),
  );
}
