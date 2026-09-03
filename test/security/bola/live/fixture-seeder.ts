import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { TableRef } from "./param-tables";

/**
 * Creates one object of a type the seeded tenant does not hold, so the routes addressing it can be
 * asked the question at all.
 *
 * ⚠ **Why this is not cheating.** The sweep's claim is "an id belonging to another organisation
 * answers 404". It can only make that claim about a route whose OWN-TENANT control answered 2xx,
 * and a control needs an object. 242 routes in the previous full run were filed unprobeable because
 * the tenant owns no row of the type they address — 45 of them address `public.candidates`, 21
 * `public.sign_envelopes`, 16 `build.project_teams` — and every one of those tables is empty across
 * ALL eight organisations in the seed, so there was nothing to borrow and nothing to copy. The
 * object has to be created or the question stays unasked.
 *
 * The row this writes is a real row of that type, owned by the source tenant, subject to every
 * constraint the table declares. It is not a fixture the sweep is allowed to reason about: it is
 * borrowed exactly like a seeded row, the control still has to answer 2xx before anything is
 * scored, and a row whose placeholder values make the handler 500 produces an UNPROBEABLE route —
 * never a pass and never a finding. That is the failure mode this fails into, and it is safe.
 *
 * What it deliberately does NOT do: guess at CHECK constraints, satisfy application invariants, or
 * retry with different shapes. A table it cannot fill is reported by name.
 */

interface ColumnMeta {
  readonly name: string;
  readonly udt: string;
  readonly typtype: string;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
  readonly generated: boolean;
  readonly attnum: number;
}

interface ForeignKey {
  readonly columns: readonly string[];
  readonly refSchema: string;
  readonly refTable: string;
  readonly refColumns: readonly string[];
}

const COLUMNS_SQL = `
SELECT n.nspname AS schema, c.relname AS "table", a.attname AS column, t.typname AS udt,
       t.typtype AS typtype, a.attnotnull AS notnull,
       (a.atthasdef OR a.attidentity <> '' OR a.attgenerated <> '') AS has_default,
       (a.attidentity <> '' OR a.attgenerated <> '') AS generated, a.attnum AS attnum
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
JOIN pg_type t ON t.oid = a.atttypid
WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'build')`;

const FK_SQL = `
SELECT n.nspname AS schema, c.relname AS "table", rn.nspname AS ref_schema, rc.relname AS ref_table,
       (SELECT array_agg(att.attname ORDER BY ord.n)
          FROM unnest(con.conkey) WITH ORDINALITY AS ord(attnum, n)
          JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ord.attnum) AS cols,
       (SELECT array_agg(att.attname ORDER BY ord.n)
          FROM unnest(con.confkey) WITH ORDINALITY AS ord(attnum, n)
          JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = ord.attnum) AS ref_cols
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_class rc ON rc.oid = con.confrelid
JOIN pg_namespace rn ON rn.oid = rc.relnamespace
WHERE con.contype = 'f' AND n.nspname IN ('public', 'build')`;

const ENUM_SQL = `
SELECT t.typname AS udt, e.enumlabel AS label
FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
ORDER BY t.typname, e.enumsortorder`;

const PK_SQL = `
SELECT n.nspname AS schema, c.relname AS "table", a.attname AS pk
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary AND array_length(i.indkey, 1) = 1
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'build')`;

export interface SeedResult {
  /** `schema.table` -> the primary key of the row that was created. */
  readonly created: ReadonlyMap<string, string>;
  /** `schema.table` -> the database's own refusal, for a table that could not be filled. */
  readonly refused: ReadonlyMap<string, string>;
}

export class FixtureSeeder {
  private readonly sql: ReturnType<typeof postgres>;
  private readonly orgId: string;
  private readonly userId: string;
  private readonly columns = new Map<string, ColumnMeta[]>();
  private readonly foreignKeys = new Map<string, ForeignKey[]>();
  private readonly enums = new Map<string, string>();
  private readonly primaryKeys = new Map<string, string>();
  private readonly created = new Map<string, string>();
  private readonly refused = new Map<string, string>();
  private readonly inFlight = new Set<string>();

  constructor(sql: ReturnType<typeof postgres>, orgId: string, userId: string) {
    this.sql = sql;
    this.orgId = orgId;
    this.userId = userId;
  }

  async load(): Promise<void> {
    const cols = await this.sql.unsafe<
      {
        schema: string;
        table: string;
        column: string;
        udt: string;
        typtype: string;
        notnull: boolean;
        has_default: boolean;
        generated: boolean;
        attnum: number;
      }[]
    >(COLUMNS_SQL);
    for (const row of cols) {
      const key = `${row.schema}.${row.table}`;
      const list = this.columns.get(key) ?? [];
      list.push({
        name: row.column,
        udt: row.udt,
        typtype: row.typtype,
        notNull: row.notnull,
        hasDefault: row.has_default,
        generated: row.generated,
        attnum: row.attnum,
      });
      this.columns.set(key, list);
    }
    const fks = await this.sql.unsafe<
      { schema: string; table: string; ref_schema: string; ref_table: string; cols: string[]; ref_cols: string[] }[]
    >(FK_SQL);
    for (const row of fks) {
      const key = `${row.schema}.${row.table}`;
      const list = this.foreignKeys.get(key) ?? [];
      list.push({
        columns: row.cols,
        refSchema: row.ref_schema,
        refTable: row.ref_table,
        refColumns: row.ref_cols,
      });
      this.foreignKeys.set(key, list);
    }
    const labels = await this.sql.unsafe<{ udt: string; label: string }[]>(ENUM_SQL);
    for (const row of labels) if (!this.enums.has(row.udt)) this.enums.set(row.udt, row.label);
    const keys = await this.sql.unsafe<{ schema: string; table: string; pk: string }[]>(PK_SQL);
    for (const row of keys) this.primaryKeys.set(`${row.schema}.${row.table}`, row.pk);
    for (const list of this.columns.values()) list.sort((a, b) => a.attnum - b.attnum);
  }

  /**
   * A value the column's own type accepts, sent as a text parameter so Postgres casts it in the
   * INSERT's known column context rather than the harness guessing at a literal.
   */
  private value(column: ColumnMeta): string {
    if (column.typtype === "e") return this.enums.get(column.udt) ?? "UNKNOWN";
    if (column.udt.startsWith("_")) return "{}";
    switch (column.udt) {
      case "uuid":
        return randomUUID();
      case "int2":
      case "int4":
      case "int8":
        return "1";
      case "numeric":
      case "float4":
      case "float8":
        return "0";
      case "bool":
        return "false";
      case "date":
        return new Date().toISOString().slice(0, 10);
      case "timestamp":
      case "timestamptz":
        return new Date().toISOString();
      case "time":
      case "timetz":
        return "00:00:00";
      case "interval":
        return "0 seconds";
      case "json":
      case "jsonb":
        return "{}";
      case "bytea":
        return "\\x";
      case "inet":
      case "cidr":
        return "127.0.0.1";
      case "vector":
        return "[0]";
      default:
        return `bola-fixture-${randomUUID().slice(0, 8)}`;
    }
  }

  /** An existing row of the referenced table this tenant may point at, or null. */
  private async referenced(fk: ForeignKey, depth: number): Promise<readonly string[] | null> {
    const key = `${fk.refSchema}.${fk.refTable}`;
    const refCols = this.columns.get(key) ?? [];
    const orgCol = refCols.find((c) => c.name === "org_id" || c.name === "organization_id");
    const select = fk.refColumns.map((c) => `"${c}"::text`).join(", ");
    const where = orgCol ? `WHERE "${orgCol.name}" = $1` : "";
    const params = orgCol ? [this.orgId] : [];
    const rows = await this.sql
      .unsafe<Record<string, string>[]>(
        `SELECT ${select} FROM "${fk.refSchema}"."${fk.refTable}" ${where} LIMIT 1`,
        params,
      )
      .catch(() => []);
    const row = rows[0];
    if (row) return Object.values(row);
    if (depth <= 0) return null;
    const seeded = await this.seed({ schema: fk.refSchema, name: fk.refTable, pk: "", orgColumn: "" }, depth - 1);
    if (seeded === null) return null;
    const again = await this.sql
      .unsafe<Record<string, string>[]>(
        `SELECT ${select} FROM "${fk.refSchema}"."${fk.refTable}" ${where} LIMIT 1`,
        params,
      )
      .catch(() => []);
    const row2 = again[0];
    return row2 ? Object.values(row2) : null;
  }

  /**
   * Writes one row of `table` owned by the source tenant. Returns its primary key, or null with the
   * database's own refusal recorded under `refused`.
   */
  async seed(table: TableRef, depth = 2): Promise<string | null> {
    const key = `${table.schema}.${table.name}`;
    const already = this.created.get(key);
    if (already !== undefined) return already;
    if (this.inFlight.has(key)) return null;
    const columns = this.columns.get(key);
    if (!columns || columns.length === 0) {
      this.refused.set(key, "no such table");
      return null;
    }
    this.inFlight.add(key);
    try {
      const values = new Map<string, string>();
      const orgColumn = columns.find((c) => c.name === "org_id" || c.name === "organization_id");
      if (orgColumn) values.set(orgColumn.name, this.orgId);

      for (const fk of this.foreignKeys.get(key) ?? []) {
        const needed = fk.columns.filter((name) => {
          const column = columns.find((c) => c.name === name);
          return column !== undefined && column.notNull && !column.generated && !values.has(name);
        });
        if (needed.length === 0) continue;
        if (fk.refSchema === table.schema && fk.refTable === table.name) continue;
        const referenced = await this.referenced(fk, depth);
        if (referenced === null) continue;
        fk.columns.forEach((name, index) => {
          const value = referenced[index];
          if (value !== undefined && !values.has(name)) values.set(name, value);
        });
      }

      const ownedByActor = new Set(["user_id", "created_by", "created_by_id", "created_by_user_id", "owner_user_id"]);
      for (const column of columns) {
        if (column.generated || values.has(column.name)) continue;
        if (!column.notNull || column.hasDefault) continue;
        values.set(column.name, ownedByActor.has(column.name) ? this.userId : this.value(column));
      }

      const names = [...values.keys()];
      if (names.length === 0) {
        this.refused.set(key, "no column could be given a value");
        return null;
      }
      const placeholders = names.map((_name, index) => `$${String(index + 1)}`).join(", ");
      const pkColumn = table.pk.length > 0 ? table.pk : (this.primaryKeys.get(key) ?? columns[0]?.name ?? "id");
      const statement =
        `INSERT INTO "${table.schema}"."${table.name}" (${names.map((n) => `"${n}"`).join(", ")}) ` +
        `VALUES (${placeholders}) RETURNING "${pkColumn}"::text AS id`;
      try {
        const rows = await this.sql.unsafe<{ id: string }[]>(statement, [...values.values()]);
        const id = rows[0]?.id;
        if (id === undefined) {
          this.refused.set(key, "insert returned no row");
          return null;
        }
        this.created.set(key, id);
        return id;
      } catch (error) {
        this.refused.set(key, String((error as Error).message).slice(0, 200));
        return null;
      }
    } finally {
      this.inFlight.delete(key);
    }
  }

  result(): SeedResult {
    return { created: this.created, refused: this.refused };
  }
}
