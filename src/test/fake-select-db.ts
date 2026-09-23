import { Column, SQL, getTableColumns, getTableName, type Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { matchesPredicate, type FakeRow, type RowSets } from "./sql-predicate";

export type TableRows = Record<string, FakeRow[]>;

type Join = { name: string; on: SQL | undefined; inner: boolean };

type Order = { table: string; column: string; descending: boolean };

const orderDialect = new PgDialect();

function findOrderColumn(value: unknown): Column | undefined {
  if (value instanceof Column) return value;
  if (value instanceof SQL) {
    for (const chunk of value.queryChunks) {
      const found = findOrderColumn(chunk);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function compareOrderValues(left: unknown, right: unknown): number {
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

function compareScopes(left: RowSets, right: RowSets, orders: Order[]): number {
  for (const order of orders) {
    const leftValue = left[order.table]?.[0]?.[order.column] ?? null;
    const rightValue = right[order.table]?.[0]?.[order.column] ?? null;
    if (leftValue === null && rightValue === null) continue;
    if (leftValue === null) return order.descending ? -1 : 1;
    if (rightValue === null) return order.descending ? 1 : -1;
    const delta = compareOrderValues(leftValue, rightValue);
    if (delta !== 0) return order.descending ? -delta : delta;
  }
  return 0;
}

type Projection = Record<string, unknown>;

const aggregateDialect = new PgDialect();

/**
 * `select({ cnt: count(x) })` used to project to `null`, so every
 * `Number(row?.cnt ?? 0)` read zero and every count assertion passed
 * vacuously no matter how many rows the predicate matched.
 *
 * Only `count` is recognised, because that is the only aggregate the read
 * paths use. Anything else still projects to `null` rather than guessing.
 */
function isCountAggregate(value: unknown): boolean {
  if (!(value instanceof SQL)) return false;
  return /^count\(/i.test(aggregateDialect.sqlToQuery(value).sql.trim());
}

function countKeysOf(projection: Projection | undefined): string[] {
  if (projection === undefined) return [];
  return Object.entries(projection)
    .filter(([, value]) => isCountAggregate(value))
    .map(([key]) => key);
}

function decodeRow(table: Table | undefined, row: FakeRow): FakeRow {
  if (table === undefined) return { ...row };
  return Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([property, column]) => [property, row[column.name] ?? null]),
  );
}

function project(projection: Projection | undefined, scope: RowSets, baseName: string, baseTable?: Table): FakeRow {
  if (projection === undefined) return decodeRow(baseTable, scope[baseName]?.[0] ?? {});
  const out: FakeRow = {};
  for (const [key, value] of Object.entries(projection)) {
    if (value instanceof Column) {
      const table = getTableName(value.table);
      out[key] = scope[table]?.[0]?.[value.name] ?? null;
    } else {
      out[key] = null;
    }
  }
  return out;
}

class SelectBuilder implements PromiseLike<FakeRow[]> {
  private baseName = "";
  private baseTable: Table | undefined;
  private readonly joins: Join[] = [];
  private predicate: SQL | undefined;
  private rowLimit = Number.POSITIVE_INFINITY;
  private readonly orders: Order[] = [];

  constructor(
    private readonly tables: TableRows,
    private readonly projection: Projection | undefined,
  ) {}

  from(table: Table): this {
    this.baseName = getTableName(table);
    this.baseTable = table;
    return this;
  }

  leftJoin(table: Table, on?: SQL): this {
    this.joins.push({ name: getTableName(table), on, inner: false });
    return this;
  }

  innerJoin(table: Table, on?: SQL): this {
    this.joins.push({ name: getTableName(table), on, inner: true });
    return this;
  }

  where(predicate?: SQL): this {
    this.predicate = predicate;
    return this;
  }

  orderBy(...entries: unknown[]): this {
    for (const entry of entries) {
      const column = findOrderColumn(entry);
      if (column === undefined) continue;
      const rendered =
        entry instanceof SQL ? orderDialect.sqlToQuery(entry).sql.trim().toLowerCase() : "";
      this.orders.push({
        table: getTableName(column.table),
        column: column.name,
        descending: rendered.endsWith(" desc"),
      });
    }
    return this;
  }

  groupBy(): this {
    return this;
  }

  for(): this {
    return this;
  }

  limit(value: number): this {
    this.rowLimit = value;
    return this;
  }

  offset(): this {
    return this;
  }

  private rowsFor(name: string): FakeRow[] {
    return this.tables[name] ?? [];
  }

  private evaluate(): FakeRow[] {
    let scopes: RowSets[] = this.rowsFor(this.baseName).map((row) => ({ [this.baseName]: [row] }));
    for (const join of this.joins) {
      const next: RowSets[] = [];
      for (const scope of scopes) {
        const matches = this.rowsFor(join.name).filter((row) =>
          matchesPredicate(join.on, { ...scope, [join.name]: [row] }),
        );
        if (matches.length === 0) {
          if (!join.inner) next.push({ ...scope, [join.name]: [] });
          continue;
        }
        for (const row of matches) next.push({ ...scope, [join.name]: [row] });
      }
      scopes = next;
    }
    const matched = scopes.filter((scope) => matchesPredicate(this.predicate, scope));
    const countKeys = countKeysOf(this.projection);
    if (countKeys.length > 0) {
      const row = project(this.projection, matched[0] ?? {}, this.baseName, this.baseTable);
      for (const key of countKeys) row[key] = matched.length;
      return [row];
    }
    if (this.orders.length > 0)
      matched.sort((left, right) => compareScopes(left, right, this.orders));
    return matched
      .slice(0, this.rowLimit)
      .map((scope) => project(this.projection, scope, this.baseName, this.baseTable));
  }

  then<TResult1 = FakeRow[], TResult2 = never>(
    onfulfilled?: ((value: FakeRow[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.evaluate()).then(onfulfilled, onrejected);
  }
}

/**
 * The write half, opt-in.
 *
 * Default `insert` throws its rows away and returns `[{ id: 1 }]`, which is
 * enough for a spec that only reads. A spec about what a *write* does — a sweep
 * that inserts one tenant's rows while another tenant's rows sit in the same
 * table — needs the row to land where the next `select` will evaluate its
 * predicate against it. Off by default so the existing read-only consumers keep
 * the cheap builder.
 */
class InsertBuilder implements PromiseLike<FakeRow[]> {
  private pending: FakeRow[] = [];

  constructor(
    private readonly tables: TableRows,
    private readonly table: Table | undefined,
  ) {}

  values(rows: FakeRow | FakeRow[]): this {
    this.pending = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  onConflictDoNothing(): this {
    return this;
  }

  onConflictDoUpdate(): this {
    return this;
  }

  returning(projection?: Projection): Promise<FakeRow[]> {
    return Promise.resolve(this.persist(projection));
  }

  private persist(projection?: Projection): FakeRow[] {
    if (this.table === undefined) return this.pending.map(() => ({ id: 1 }));
    const name = getTableName(this.table);
    const columns = getTableColumns(this.table);
    const stored = this.tables[name] ?? [];
    this.tables[name] = stored;
    const written: FakeRow[] = [];
    for (const row of this.pending) {
      const encoded: FakeRow = {};
      for (const [property, column] of Object.entries(columns))
        if (property in row) encoded[column.name] = row[property];
      if ("id" in columns && encoded.id === undefined)
        encoded.id = stored.reduce((top, existing) => Math.max(top, Number(existing.id ?? 0)), 0) + 1;
      stored.push(encoded);
      written.push(
        projection === undefined
          ? { ...encoded }
          : Object.fromEntries(
              Object.entries(projection).map(([key, value]) => [
                key,
                value instanceof Column ? (encoded[value.name] ?? null) : null,
              ]),
            ),
      );
    }
    return written;
  }

  then<TResult1 = FakeRow[], TResult2 = never>(
    onfulfilled?: ((value: FakeRow[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.persist()).then(onfulfilled, onrejected);
  }
}

export type FakeDb = {
  select: (projection?: Projection) => SelectBuilder;
  query: Record<string, { findFirst: (args?: { where?: SQL }) => Promise<FakeRow | undefined>; findMany: (args?: { where?: SQL }) => Promise<FakeRow[]> }>;
  update: () => { set: () => { where: () => Promise<FakeRow[]> } };
  insert: (table?: Table) => { values: (rows: FakeRow | FakeRow[]) => { returning: (projection?: Projection) => Promise<FakeRow[]> } };
  transaction: <T>(callback: (tx: FakeDb) => Promise<T>) => Promise<T>;
  execute: () => Promise<FakeRow[]>;
};

export function makeFakeDb(
  tables: TableRows,
  relationalTables: Record<string, Table> = {},
  options: { persistInserts?: boolean } = {},
): FakeDb {
  const query: FakeDb["query"] = {};
  for (const [key, table] of Object.entries(relationalTables)) {
    const tableName = getTableName(table);
    const columns = Object.entries(getTableColumns(table)).map(([property, column]) => [property, column.name] as const);
    const decode = (row: FakeRow): FakeRow => Object.fromEntries(columns.map(([property, name]) => [property, row[name] ?? null]));
    const rows = () => tables[tableName] ?? [];
    const select = (args?: { where?: SQL }) =>
      rows().filter((row) => matchesPredicate(args?.where, { [tableName]: [row] })).map(decode);
    query[key] = {
      findMany: (args) => Promise.resolve(select(args)),
      findFirst: (args) => Promise.resolve(select(args)[0]),
    };
  }
  const db: FakeDb = {
    select: (projection?: Projection) => new SelectBuilder(tables, projection),
    query,
    update: () => ({ set: () => ({ where: () => Promise.resolve([{ id: 1 }]) }) }),
    insert: (table?: Table) =>
      options.persistInserts === true
        ? new InsertBuilder(tables, table)
        : { values: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) },
    transaction: (callback) => callback(db),
    execute: () => Promise.resolve([]),
  };
  return db;
}
