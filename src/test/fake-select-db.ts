import { Column, SQL, getTableName, type Table } from "drizzle-orm";
import { matchesPredicate, type FakeRow, type RowSets } from "./sql-predicate";

export type TableRows = Record<string, FakeRow[]>;

type Join = { name: string; on: SQL | undefined; inner: boolean };

type Projection = Record<string, unknown>;

function project(projection: Projection | undefined, scope: RowSets, baseName: string): FakeRow {
  if (projection === undefined) return { ...(scope[baseName]?.[0] ?? {}) };
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
  private readonly joins: Join[] = [];
  private predicate: SQL | undefined;
  private rowLimit = Number.POSITIVE_INFINITY;

  constructor(
    private readonly tables: TableRows,
    private readonly projection: Projection | undefined,
  ) {}

  from(table: Table): this {
    this.baseName = getTableName(table);
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

  orderBy(): this {
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
    return scopes
      .filter((scope) => matchesPredicate(this.predicate, scope))
      .slice(0, this.rowLimit)
      .map((scope) => project(this.projection, scope, this.baseName));
  }

  then<TResult1 = FakeRow[], TResult2 = never>(
    onfulfilled?: ((value: FakeRow[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.evaluate()).then(onfulfilled, onrejected);
  }
}

export type FakeDb = {
  select: (projection?: Projection) => SelectBuilder;
  query: Record<string, { findFirst: (args?: { where?: SQL }) => Promise<FakeRow | undefined>; findMany: (args?: { where?: SQL }) => Promise<FakeRow[]> }>;
  update: () => { set: () => { where: () => Promise<FakeRow[]> } };
  insert: () => { values: () => { returning: () => Promise<FakeRow[]> } };
  transaction: <T>(callback: (tx: FakeDb) => Promise<T>) => Promise<T>;
  execute: () => Promise<FakeRow[]>;
};

export function makeFakeDb(tables: TableRows, relationalTables: Record<string, string> = {}): FakeDb {
  const query: FakeDb["query"] = {};
  for (const [key, tableName] of Object.entries(relationalTables)) {
    const rows = () => tables[tableName] ?? [];
    query[key] = {
      findMany: (args) =>
        Promise.resolve(rows().filter((row) => matchesPredicate(args?.where, { [tableName]: [row] }))),
      findFirst: (args) =>
        Promise.resolve(rows().find((row) => matchesPredicate(args?.where, { [tableName]: [row] }))),
    };
  }
  const db: FakeDb = {
    select: (projection?: Projection) => new SelectBuilder(tables, projection),
    query,
    update: () => ({ set: () => ({ where: () => Promise.resolve([{ id: 1 }]) }) }),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) }),
    transaction: (callback) => callback(db),
    execute: () => Promise.resolve([]),
  };
  return db;
}
