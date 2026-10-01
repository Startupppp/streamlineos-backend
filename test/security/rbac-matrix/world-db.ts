import { Column, Param, SQL, StringChunk, Table, getTableColumns, getTableName, is } from "drizzle-orm";
import * as schema from "src/db/schema";
import type { Db, TenantTx } from "src/db/drizzle.types";

export type Row = Readonly<Record<string, unknown>>;
export type WorldRows = ReadonlyMap<Table, readonly Row[]>;

export interface WriteRecord {
  readonly verb: "insert" | "update" | "delete";
  readonly table: string;
  values: unknown;
  where: unknown;
}

export interface ReadRecord {
  readonly table: string;
  readonly where: unknown;
}

export interface WorldDb {
  readonly db: Db;
  readonly tx: TenantTx;
  readonly rows: WorldRows;
  readonly writes: WriteRecord[];
  readonly reads: ReadRecord[];
}

interface Constraint {
  readonly column: Column;
  readonly values: readonly unknown[];
}

export function standIn<T>(shape: object): T {
  return shape as T;
}

function chunkText(chunk: unknown): string {
  return chunk instanceof StringChunk ? chunk.value.join("").trim().toLowerCase() : "";
}

function constraintsOf(node: unknown, out: Constraint[] = []): Constraint[] {
  if (!(node instanceof SQL)) return out;
  const chunks: unknown[] = node.queryChunks;
  if (chunks.some((chunk) => chunkText(chunk) === "or" || chunkText(chunk).startsWith("not"))) return out;
  chunks.forEach((chunk, index) => {
    if (chunk instanceof SQL) {
      constraintsOf(chunk, out);
      return;
    }
    if (!(chunk instanceof Column)) return;
    const operator = chunkText(chunks[index + 1]);
    const operand = chunks[index + 2];
    if (operator === "=" && operand instanceof Param) out.push({ column: chunk, values: [operand.value] });
    if (operator === "in" && Array.isArray(operand))
      out.push({
        column: chunk,
        values: operand.filter((item): item is Param => item instanceof Param).map((item) => item.value),
      });
  });
  return out;
}

export function boundValues(node: unknown, seen = new Set<object>()): unknown[] {
  if (node === null || node === undefined) return [];
  if (typeof node !== "object") return [node];
  if (seen.has(node)) return [];
  seen.add(node);
  if (Array.isArray(node)) return node.flatMap((item) => boundValues(item, seen));
  if (node instanceof Param) return boundValues(node.value, seen);
  if (node instanceof SQL) return boundValues(node.queryChunks, seen);
  return [];
}

function propertyOf(column: Column): string | undefined {
  const columns: Record<string, Column> = getTableColumns(column.table);
  return Object.keys(columns).find((key) => columns[key] === column);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  return left === right;
}

function admits(row: Row, from: Table, constraints: readonly Constraint[]): boolean {
  const own: Record<string, Column> = getTableColumns(from);
  return constraints.every(({ column, values }) => {
    const property = propertyOf(column);
    if (property === undefined || !(property in row)) return true;
    if (column.table !== from && property in own) return true;
    return values.some((value) => sameValue(row[property], value));
  });
}

class SelectQuery implements PromiseLike<Row[]> {
  private table: Table | undefined;
  private predicate: unknown;
  private readonly joins: unknown[] = [];
  private cap = Number.POSITIVE_INFINITY;

  constructor(
    private readonly rows: WorldRows,
    private readonly reads: ReadRecord[],
  ) {}

  from(table: Table): this {
    this.table = table;
    return this;
  }

  innerJoin(_table: unknown, on: unknown): this {
    this.joins.push(on);
    return this;
  }

  leftJoin(): this {
    return this;
  }

  where(predicate: unknown): this {
    this.predicate = predicate;
    return this;
  }

  orderBy(): this {
    return this;
  }

  groupBy(): this {
    return this;
  }

  limit(cap: number): this {
    this.cap = cap;
    return this;
  }

  offset(): this {
    return this;
  }

  for(): this {
    return this;
  }

  resolve(): Row[] {
    const table = this.table;
    if (table === undefined) throw new Error("world-db: select without from");
    this.reads.push({ table: getTableName(table), where: this.predicate });
    const constraints = [this.predicate, ...this.joins].flatMap((node) => constraintsOf(node));
    return (this.rows.get(table) ?? [])
      .filter((row) => admits(row, table, constraints))
      .slice(0, this.cap)
      .map((row) => ({ ...row }));
  }

  then<A = Row[], B = never>(
    onfulfilled?: ((value: Row[]) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve()
      .then(() => this.resolve())
      .then(onfulfilled, onrejected);
  }

  catch<B = never>(onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null): PromiseLike<Row[] | B> {
    return this.then(undefined, onrejected);
  }
}

class WriteQuery implements PromiseLike<Row[]> {
  constructor(
    private readonly record: WriteRecord,
    private readonly nextId: () => number,
    private readonly matching: (predicate: unknown) => Row[],
  ) {}

  values(values: unknown): this {
    this.record.values = values;
    return this;
  }

  set(values: unknown): this {
    this.record.values = values;
    return this;
  }

  where(predicate: unknown): this {
    this.record.where = predicate;
    return this;
  }

  onConflictDoNothing(): this {
    return this;
  }

  onConflictDoUpdate(): this {
    return this;
  }

  returning(): this {
    return this;
  }

  then<A = Row[], B = never>(
    onfulfilled?: ((value: Row[]) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    const values = typeof this.record.values === "object" ? this.record.values : {};
    const written =
      this.record.verb === "insert"
        ? [{ id: this.nextId(), ...values }]
        : this.record.verb === "update"
          ? this.matching(this.record.where).map((row) => ({ ...row, ...values }))
          : [];
    return Promise.resolve(written).then(onfulfilled, onrejected);
  }

  catch<B = never>(onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null): PromiseLike<Row[] | B> {
    return this.then(undefined, onrejected);
  }
}

export function mergeRows(...parts: readonly WorldRows[]): Map<Table, Row[]> {
  const merged = new Map<Table, Row[]>();
  for (const part of parts)
    for (const [table, rows] of part) merged.set(table, [...(merged.get(table) ?? []), ...rows]);
  return merged;
}

export function worldDb(rows: WorldRows): WorldDb {
  const writes: WriteRecord[] = [];
  const reads: ReadRecord[] = [];
  let sequence = 10_000;
  const nextId = (): number => {
    sequence += 1;
    return sequence;
  };
  const write = (verb: WriteRecord["verb"], table: Table): WriteQuery => {
    const record: WriteRecord = { verb, table: getTableName(table), values: undefined, where: undefined };
    writes.push(record);
    return new WriteQuery(record, nextId, (predicate) => new SelectQuery(rows, []).from(table).where(predicate).resolve());
  };
  const relational = (table: Table) => {
    const find = (options: { where?: unknown } = {}): Row[] => {
      if (typeof options.where === "function")
        throw new Error(`world-db: callback where on ${getTableName(table)} is not modelled`);
      return new SelectQuery(rows, reads).from(table).where(options.where).resolve();
    };
    return {
      findFirst: async (options?: { where?: unknown }): Promise<Row | undefined> => find(options)[0],
      findMany: async (options?: { where?: unknown }): Promise<Row[]> => find(options),
    };
  };
  const query: Record<string, ReturnType<typeof relational>> = {};
  for (const [key, value] of Object.entries(schema)) if (is(value, Table)) query[key] = relational(value);

  const fake = {
    query,
    select: () => new SelectQuery(rows, reads),
    selectDistinct: () => new SelectQuery(rows, reads),
    insert: (table: Table) => write("insert", table),
    update: (table: Table) => write("update", table),
    delete: (table: Table) => write("delete", table),
    execute: async (): Promise<Row[]> => [],
    transaction: async <T>(work: (tx: object) => Promise<T>): Promise<T> => work(fake),
  };
  return { db: standIn<Db>(fake), tx: standIn<TenantTx>(fake), rows, writes, reads };
}
