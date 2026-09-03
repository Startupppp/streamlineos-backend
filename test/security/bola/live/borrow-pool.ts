import type postgres from "postgres";
import type { TableRef } from "./param-tables";

/**
 * The ids the sweep borrows, read from the database at the moment it borrows them.
 *
 * ⚠ **This replaces a snapshot, and the snapshot was the binding constraint on the sweep's reach.**
 * `fixture-catalog.ts` reads every tenant-owned id once, before the first request. That was fine
 * while the sweep bounced off the validation interceptor; once each route carried a contract-derived
 * body, ~270 mutations began to EXECUTE, and a run of 1,929 real requests against one database
 * consumes and re-states the very objects its later routes borrow. An id deleted at route 400 was
 * still being offered at route 1,600, and its own-tenant control answered 404 — filed as "this route
 * could not be reached", which is not what happened. Measured between the two full runs:
 * own-tenant control-404 rose 135 -> 355 and "no object of that type" 168 -> 334, while 93 routes,
 * every one of them a DELETE, ran their table's pool dry.
 *
 * Three things this pool does that the snapshot could not:
 *
 *   fresh      every borrow re-reads the table, so a row another route deleted is never offered
 *              again and a row another route created is available immediately;
 *   visible    rows carrying `deleted_at` are excluded, because a soft-deleted row is invisible to
 *              every handler (`backend/CLAUDE.md` §3) and borrowing one guarantees a control 404;
 *   the actor's own  rows whose owner column names the source USER are offered first, because a
 *              handler that says "Not your timer" / "You can only submit your own period" /
 *              "You are not a member of this channel" refuses an object the tenant owns but the
 *              caller does not. 43 own-tenant control-403s in the previous run are that shape.
 *
 * It is still only a candidate generator. Nothing here decides a verdict: the sweep scores a route
 * only when the own-tenant control answered 2xx, so a wrong id costs coverage, never correctness.
 */

/** Columns that name the human a row belongs to, in the order a handler is likeliest to check. */
const ACTOR_COLUMNS: readonly string[] = [
  "user_id",
  "owner_user_id",
  "actor_user_id",
  "created_by_user_id",
  "created_by_id",
  "created_by",
  "owner_id",
  "assigned_to_id",
  "assignee_id",
  "assigned_to_user_id",
  "requested_by",
  "requested_by_user_id",
  "employee_user_id",
  "author_id",
  "author_user_id",
  "member_user_id",
  "submitted_by",
];

const SOFT_DELETE_COLUMNS: readonly string[] = ["deleted_at", "archived_at"];

const COLUMNS_QUERY = `
SELECT n.nspname AS schema, c.relname AS name, a.attname AS column
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'build')`;

export interface PoolStats {
  /** Tables whose live read was issued at least once. */
  readonly tablesRead: number;
  /** Live reads issued. One per borrow that could not be served from the short cache. */
  readonly reads: number;
  /** Ids withheld because a DELETE route had already been handed them in this run. */
  readonly withheld: number;
  /** Tables where at least one row belongs to the source user and was therefore offered first. */
  readonly actorPreferred: number;
}

export interface BorrowPoolOptions {
  /** Ids read per table per refresh. */
  readonly perTable?: number;
  /** How long a live read may be reused before the table is re-read, in milliseconds. */
  readonly ttlMs?: number;
}

export class BorrowPool {
  private readonly sql: ReturnType<typeof postgres>;
  private readonly orgId: string;
  private readonly userId: string;
  private readonly perTable: number;
  private readonly ttlMs: number;
  private readonly columns = new Map<string, ReadonlySet<string>>();
  private readonly cache = new Map<string, { ids: readonly string[]; at: number }>();
  /** Ids a DELETE route has already been handed, so no two routes are given the same one. */
  private readonly handedOut = new Set<string>();
  private readonly actorTables = new Set<string>();
  private reads = 0;
  private withheld = 0;

  constructor(
    sql: ReturnType<typeof postgres>,
    orgId: string,
    userId: string,
    options: BorrowPoolOptions = {},
  ) {
    this.sql = sql;
    this.orgId = orgId;
    this.userId = userId;
    this.perTable = options.perTable ?? 64;
    this.ttlMs = options.ttlMs ?? 20_000;
  }

  /** Reads the column names of every candidate table once. Must be awaited before any borrow. */
  async loadColumns(): Promise<number> {
    const rows = await this.sql.unsafe<{ schema: string; name: string; column: string }[]>(COLUMNS_QUERY);
    for (const row of rows) {
      const key = `${row.schema}.${row.name}`;
      const existing = this.columns.get(key);
      if (existing) (existing as Set<string>).add(row.column);
      else this.columns.set(key, new Set<string>([row.column]));
    }
    return this.columns.size;
  }

  private actorColumn(table: TableRef): string | null {
    const cols = this.columns.get(`${table.schema}.${table.name}`);
    if (!cols) return null;
    return ACTOR_COLUMNS.find((candidate) => cols.has(candidate)) ?? null;
  }

  private softDeleteColumn(table: TableRef): string | null {
    const cols = this.columns.get(`${table.schema}.${table.name}`);
    if (!cols) return null;
    return SOFT_DELETE_COLUMNS.find((candidate) => cols.has(candidate)) ?? null;
  }

  /**
   * Reads this table's currently-live ids for the source tenant.
   *
   * `descending` is for DELETE routes, which take from the far end so they do not consume the ids
   * every read route in front of them is using.
   */
  private async read(table: TableRef, descending: boolean): Promise<readonly string[]> {
    const key = `${table.schema}.${table.name}${descending ? ":desc" : ""}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.ids;

    const actor = this.actorColumn(table);
    const soft = this.softDeleteColumn(table);
    const order: string[] = [];
    if (actor !== null) order.push(`CASE WHEN "${actor}" = $2 THEN 0 ELSE 1 END`);
    order.push(`"${table.pk}" ${descending ? "DESC" : "ASC"}`);
    const where = [`"${table.orgColumn}" = $1`];
    if (soft !== null) where.push(`"${soft}" IS NULL`);
    const mine = actor === null ? "false" : `("${actor}" = $2)`;
    const statement =
      `SELECT "${table.pk}"::text AS id, ${mine} AS mine FROM "${table.schema}"."${table.name}" ` +
      `WHERE ${where.join(" AND ")} ORDER BY ${order.join(", ")} LIMIT ${String(this.perTable)}`;

    this.reads += 1;
    let ids: string[] = [];
    try {
      const rows = await this.sql.unsafe<{ id: string; mine: boolean }[]>(
        statement,
        actor === null ? [this.orgId] : [this.orgId, this.userId],
      );
      ids = rows.map((row) => row.id);
      if (rows.some((row) => row.mine)) this.actorTables.add(`${table.schema}.${table.name}`);
    } catch {
      ids = [];
    }
    this.cache.set(key, { ids, at: Date.now() });
    return ids;
  }

  /**
   * One id for this table, or null when the tenant holds none the caller has not already been given.
   *
   * `index` is the attempt number: attempt 0 gets the best candidate, attempt 1 the next, and so on,
   * so a route whose first object is in a status the handler refuses still gets a second chance.
   * A DELETE consumes its object, so a DELETE never sees an id this run has already handed out.
   */
  async borrow(table: TableRef, index: number, consuming: boolean): Promise<string | null> {
    const ids = await this.read(table, consuming);
    if (ids.length === 0) return null;
    if (!consuming) return ids[index] ?? null;
    const free = ids.filter((id) => !this.handedOut.has(`${table.schema}.${table.name}#${id}`));
    this.withheld += ids.length - free.length;
    const chosen = free[0];
    if (chosen === undefined) return null;
    this.handedOut.add(`${table.schema}.${table.name}#${chosen}`);
    return chosen;
  }

  /** Drops the cached read for a table, so the next borrow re-reads it. */
  invalidate(table: TableRef): void {
    this.cache.delete(`${table.schema}.${table.name}`);
    this.cache.delete(`${table.schema}.${table.name}:desc`);
  }

  stats(): PoolStats {
    return {
      tablesRead: new Set([...this.cache.keys()].map((key) => key.replace(/:desc$/, ""))).size,
      reads: this.reads,
      withheld: this.withheld,
      actorPreferred: this.actorTables.size,
    };
  }
}
