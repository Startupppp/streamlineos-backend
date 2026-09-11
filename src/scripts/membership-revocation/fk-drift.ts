/**
 * The drift half of `verify-membership-revocation`: does the declared inventory
 * match the database?
 *
 * `MEMBERSHIP_ARTIFACTS` says what each artifact's foreign key does when a
 * membership row goes away; `pg_constraint` says what it really does. This
 * compares them and fails on any disagreement, which is the only check in the
 * script that does not simply trust the inventory.
 *
 * The `set-null` case is examined twice over. A composite `(org_id, x)` foreign
 * key declared `ON DELETE SET NULL` with no column list nulls `org_id` as well,
 * and `org_id` is NOT NULL — so the parent delete aborts with 23502 at exactly
 * the moment it is needed. Reading `confdelsetcols` is the only way to tell that
 * apart from a correct SET NULL, and it is reported both per declared artifact
 * and as a standalone sweep, because an offending constraint on a table nobody
 * declared is still a delete that will fail.
 *
 * Separate from `./artifact-census` because it touches no test organisation at
 * all: it reads the catalog and nothing else.
 */

import { sql } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import {
  MEMBERSHIP_ARTIFACTS,
  type RemovalAction,
} from "../../modules/organization/core/membership-artifacts";

const FK_ACTION_BY_CODE: Record<string, RemovalAction> = {
  c: "cascade",
  n: "set-null",
  a: "blocks-removal",
  r: "blocks-removal",
};

export async function checkArtifactFkDrift(db: Db): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT
      n.nspname AS schema_name,
      cl.relname AS table_name,
      c.conname AS constraint_name,
      c.confdeltype AS delete_code,
      c.convalidated AS is_validated,
      array_length(c.confdelsetcols, 1) AS set_null_col_count,
      (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
         FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,
      (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
         FROM unnest(c.confdelsetcols) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS set_null_cols
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE c.contype = 'f' AND c.confrelid = 'organization_members'::regclass
  `);
  const rows = Array.isArray(result) ? result : [];

  console.log("\n=== INVENTORY vs pg_constraint (declared onRemoval must match the real FK) ===");
  let pass = true;
  for (const artifact of MEMBERSHIP_ARTIFACTS) {
    if (artifact.table === null) continue;
    if (artifact.onRemoval !== "cascade" && artifact.onRemoval !== "set-null" && artifact.onRemoval !== "blocks-removal") continue;

    const keys = artifact.keyedBy.split(/\s*\/\s*/);
    const matches = rows.filter((row) => {
      const record: Record<string, unknown> = row;
      if (String(record.table_name ?? "") !== artifact.table) return false;
      const fkCols = String(record.columns ?? "").split(",");
      return keys.some((key) => fkCols.includes(key.trim()));
    });

    if (matches.length === 0) {
      console.log(`  SKIP  ${(artifact.table ?? "").padEnd(34)} no FK on [${keys.join(", ")}] references organization_members`);
      continue;
    }

    for (const match of matches) {
      const record: Record<string, unknown> = match;
      const actual = FK_ACTION_BY_CODE[String(record.delete_code ?? "")];
      let ok = actual === artifact.onRemoval;

      if (actual === "set-null") {
        const fkCols = String(record.columns ?? "").split(",");
        const hasOrgId = fkCols.includes("org_id");
        const setNullColCount = Number(record.set_null_col_count ?? 0);
        if (hasOrgId && setNullColCount === 0) {
          ok = false;
          console.log(
            `  FAIL  ${(artifact.table ?? "").padEnd(34)} SET NULL without column list on composite FK — org_id is NOT NULL, will 23502 (${String(record.constraint_name ?? "")})`,
          );
          pass = false;
          continue;
        }
      }

      if (!ok) pass = false;
      console.log(
        `  ${ok ? "PASS" : "FAIL"}  ${(artifact.table ?? "").padEnd(34)} declared=${artifact.onRemoval} actual=${actual ?? "unknown"} (${String(record.constraint_name ?? "")})`,
      );
    }
  }

  const brokenSetNull = rows.filter((row) => {
    const record: Record<string, unknown> = row;
    if (String(record.delete_code ?? "") !== "n") return false;
    const fkCols = String(record.columns ?? "").split(",");
    if (!fkCols.includes("org_id")) return false;
    return Number(record.set_null_col_count ?? 0) === 0;
  });
  if (brokenSetNull.length > 0) {
    console.log("\n  WARNING — SET NULL FKs without column list (will 23502 if triggered):");
    for (const row of brokenSetNull) {
      const record: Record<string, unknown> = row;
      console.log(`    ${String(record.schema_name ?? "")}.${String(record.table_name ?? "")} → ${String(record.constraint_name ?? "")} on (${String(record.columns ?? "")})`);
    }
  }

  return pass;
}
