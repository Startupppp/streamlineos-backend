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
  /** The trigger function's source. A shared function names its target column here, not in the args. */
  readonly body: string;
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
         pg_get_triggerdef(t.oid) AS "definition",
         COALESCE(p.prosrc, '') AS "body"
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE NOT t.tgisinternal
    AND (t.tgtype & 1) <> 0
    AND (t.tgtype & 2) <> 0
    AND (t.tgtype & 4) <> 0
`;

const escape = (column: string): string => column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Word-boundary rather than substring: `org_id` must not match `source_org_id`.
 * `_` is a word character, so \b does that correctly, and the trigger definition
 * quotes the argument (`'org_id'`), which supplies the boundaries.
 */
export function triggerNamesColumn(definition: string, column: string): boolean {
  return new RegExp(`\\b${escape(column)}\\b`).test(definition);
}

/**
 * The column a SHARED trigger function fills is named in its BODY, not in its
 * arguments — and reading the arguments alone reports a false 23502.
 *
 * `set_org_id_from_parent(parent, parent_key, parent_org_col, child_fk_col)` ends
 * `NEW.org_id := v_org;`. The child column is hardcoded; the third argument is the
 * PARENT's org column, which control-plane parents spell `organization_id`. So on
 * `organization_saga_steps` the definition reads
 * `set_org_id_from_parent('organization_lifecycle_sagas', 'saga_id', 'organization_id', 'saga_id')`
 * and `\borg_id\b` matches nothing in it: not inside `organization_id`, and not
 * inside the function name, where `org_id` is flanked by `_` on both sides. The
 * same trigger on `invoice_items` passes `'org_id'` as that argument and so was
 * recognised — the gate's verdict turned on the PARENT's column name, which has
 * nothing to do with whether the child's column gets a value.
 *
 * Proven against the catalog before this was widened: inserting into
 * `organization_saga_steps` with no `org_id` succeeds and the trigger fills it.
 *
 * An assignment, not a mention — `to_jsonb(NEW) ->> 'org_id'` in the same body is
 * a read, and must not count. plpgsql is case-insensitive, hence the `i` flag.
 */
export function triggerAssignsColumn(body: string, column: string): boolean {
  return new RegExp(`\\bNEW\\s*\\.\\s*${escape(column)}\\s*:=`, "i").test(body);
}

/** A BEFORE INSERT row trigger supplies a column if its args name it or its body assigns it. */
export function triggerSuppliesColumn(trigger: LiveTrigger, column: string): boolean {
  return (
    triggerNamesColumn(trigger.definition, column) || triggerAssignsColumn(trigger.body, column)
  );
}
