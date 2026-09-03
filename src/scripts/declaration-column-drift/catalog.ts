/**
 * The LIVE half: what `pg_catalog` says a table actually has, and the two
 * predicates that decide what that means for a write. Split out of the entry
 * script under CLAUDE.md §7; the entry file carries the defect narrative.
 *
 * Nothing here reaches a database — these are the query TEXTS and the row
 * shapes they project, so the self-test can assert on them without one.
 */

export interface LiveColumn {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
  readonly isIdentity: boolean;
  readonly isGenerated: boolean;
}

export interface LiveTrigger {
  readonly schema: string;
  readonly table: string;
  readonly trigger: string;
  readonly definition: string;
}

/**
 * A column Postgres demands a value for on INSERT. `serial`/`identity` and every
 * defaulted column are excluded: Drizzle omitting those is correct, not drift.
 * `attgenerated <> ''` also sets `atthasdef`, so it is excluded explicitly rather
 * than relied on.
 */
export function requiresValueOnInsert(column: LiveColumn): boolean {
  if (!column.notNull) return false;
  if (column.hasDefault) return false;
  if (column.isIdentity) return false;
  if (column.isGenerated) return false;
  return true;
}

export const LIVE_COLUMNS_QUERY = `
  SELECT n.nspname                                   AS "schema",
         c.relname                                   AS "table",
         a.attname                                   AS "column",
         a.attnotnull                                AS "notNull",
         (a.atthasdef AND a.attgenerated = '')       AS "hasDefault",
         (a.attidentity <> '')                       AS "isIdentity",
         (a.attgenerated <> '')                      AS "isGenerated"
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE a.attnum > 0
    AND NOT a.attisdropped
    AND c.relkind IN ('r', 'p')
    AND NOT c.relispartition
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'drizzle', 'pg_toast')
`;

/**
 * `tgtype` bits: 1 = FOR EACH ROW, 2 = BEFORE, 4 = INSERT. A statement-level or
 * AFTER trigger cannot supply a value to the row being inserted, so neither
 * qualifies as a reason to downgrade a missing NOT NULL column.
 */
export const INSERT_TRIGGERS_QUERY = `
  SELECT n.nspname            AS "schema",
         c.relname            AS "table",
         t.tgname             AS "trigger",
         pg_get_triggerdef(t.oid) AS "definition"
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE NOT t.tgisinternal
    AND (t.tgtype & 1) <> 0
    AND (t.tgtype & 2) <> 0
    AND (t.tgtype & 4) <> 0
`;

/**
 * Word-boundary rather than substring: `org_id` must not match `source_org_id`.
 * `_` is a word character, so \b does that correctly, and the trigger definition
 * quotes the argument (`'org_id'`), which supplies the boundaries.
 */
export function triggerNamesColumn(definition: string, column: string): boolean {
  return new RegExp(`\\b${column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(definition);
}
