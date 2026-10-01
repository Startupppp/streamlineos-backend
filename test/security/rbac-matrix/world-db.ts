import { Column, Param, SQL, StringChunk, Table, getTableColumns, getTableName, is } from "drizzle-orm";
import * as schema from "src/db/schema";
import type { Db, TenantTx } from "src/db/drizzle.types";
import {
  UnsupportedQuery,
  compareRows,
  evaluate,
  orderKey,
  propertyOf,
  scalar,
  sqlText,
  type Lookup,
  type Row,
  type Subselect,
} from "./world-db-sql";

export { UnsupportedQuery, type Row };
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
  readonly settings: Array<Readonly<Record<string, string>>>;
}

type Combo = ReadonlyMap<Table, Row | null>;

interface Join {
  readonly table: Table;
  readonly on: unknown;
  readonly outer: boolean;
}

const SCHEMA_TABLES = new Set<Table>();
for (const value of Object.values(schema)) if (is(value, Table)) SCHEMA_TABLES.add(value);

export function standIn<T>(shape: object): T {
  return shape as T;
}

function knownTable(table: unknown): Table {
  if (!is(table, Table) || !SCHEMA_TABLES.has(table)) throw new UnsupportedQuery("source that is not a plain schema table");
  return table;
}

function subselectOver(rows: WorldRows): Subselect {
  return (tableName, columnName, conditions) => {
    const table = [...SCHEMA_TABLES].find((candidate) => getTableName(candidate) === tableName);
    if (table === undefined) throw new UnsupportedQuery(`subselect over unknown table ${tableName}`);
    const columns: Record<string, Column> = getTableColumns(table);
    const propertyNamed = (name: string): string => {
      const property = Object.keys(columns).find((key) => columns[key].name === name);
      if (property === undefined) throw new UnsupportedQuery(`subselect column ${tableName}.${name}`);
      return property;
    };
    const wanted = propertyNamed(columnName);
    const filters: Array<readonly [string, unknown]> = conditions.map(([name, value]) => [propertyNamed(name), value]);
    return (rows.get(table) ?? [])
      .filter((row) =>
        filters.every(([property, value]) => {
          if (!(property in row)) throw new UnsupportedQuery(`fixture row of ${tableName} has no ${property} column the subselect reads`);
          return compareRows(row[property], value) === 0 && row[property] !== null && row[property] !== undefined;
        }),
      )
      .map((row) => {
        if (!(wanted in row)) throw new UnsupportedQuery(`fixture row of ${tableName} has no ${wanted} column the subselect projects`);
        return row[wanted];
      });
  };
}

function lookupIn(combo: Combo): Lookup {
  return (column) => {
    if (!combo.has(column.table)) throw new UnsupportedQuery(`column ${getTableName(column.table)}.${column.name} not in the query's tables`);
    const row = combo.get(column.table);
    if (row === null || row === undefined) return null;
    const property = propertyOf(column);
    if (!(property in row))
      throw new UnsupportedQuery(`fixture row of ${getTableName(column.table)} has no ${property} column the query reads`);
    return row[property];
  };
}

function project(fields: unknown, combo: Combo, subselect: Subselect): unknown {
  if (is(fields, Column) || is(fields, SQL) || is(fields, SQL.Aliased)) return scalar(fields, lookupIn(combo), subselect);
  if (fields === null || typeof fields !== "object") throw new UnsupportedQuery("projection shape");
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, project(value, combo, subselect)]));
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

class SelectQuery implements PromiseLike<unknown[]> {
  private table: Table | undefined;
  private predicate: unknown;
  private readonly joins: Join[] = [];
  private readonly order: unknown[] = [];
  private cap = Number.POSITIVE_INFINITY;
  private skip = 0;

  constructor(
    private readonly rows: WorldRows,
    private readonly reads: ReadRecord[],
    private readonly fields: unknown,
    private readonly distinct: boolean,
  ) {}

  from(table: unknown): this {
    this.table = knownTable(table);
    return this;
  }

  innerJoin(table: unknown, on: unknown): this {
    this.joins.push({ table: knownTable(table), on, outer: false });
    return this;
  }

  leftJoin(table: unknown, on: unknown): this {
    this.joins.push({ table: knownTable(table), on, outer: true });
    return this;
  }

  where(predicate: unknown): this {
    this.predicate = predicate;
    return this;
  }

  orderBy(...keys: unknown[]): this {
    this.order.push(...keys.flat());
    return this;
  }

  groupBy(): this {
    throw new UnsupportedQuery("groupBy");
  }

  limit(cap: number): this {
    this.cap = cap;
    return this;
  }

  offset(skip: number): this {
    this.skip = skip;
    return this;
  }

  for(): this {
    return this;
  }

  private combos(): Combo[] {
    const table = this.table;
    if (table === undefined) throw new UnsupportedQuery("select without from");
    let combos: Combo[] = (this.rows.get(table) ?? []).map((row) => new Map([[table, row]]));
    for (const join of this.joins) {
      const candidates = this.rows.get(join.table) ?? [];
      combos = combos.flatMap((combo) => {
        const matched = candidates
          .map((row): Combo => new Map([...combo, [join.table, row]]))
          .filter((next) => evaluate(join.on, lookupIn(next), subselectOver(this.rows)) === true);
        if (matched.length > 0 || !join.outer) return matched;
        return [new Map([...combo, [join.table, null]])];
      });
    }
    return combos.filter((combo) => evaluate(this.predicate, lookupIn(combo), subselectOver(this.rows)) === true);
  }

  resolve(): unknown[] {
    const table = this.table;
    if (table === undefined) throw new UnsupportedQuery("select without from");
    this.reads.push({ table: getTableName(table), where: this.predicate });
    const keys = this.order.map(orderKey);
    const sorted = [...this.combos()].sort((left, right) => {
      for (const key of keys) {
        const order = compareRows(lookupIn(left)(key.column), lookupIn(right)(key.column));
        if (order !== 0) return key.descending ? -order : order;
      }
      return 0;
    });
    let out = sorted.map((combo) => {
      if (this.fields !== undefined) return project(this.fields, combo, subselectOver(this.rows));
      if (this.joins.length > 0) throw new UnsupportedQuery("field-less select over a join");
      return { ...combo.get(table) };
    });
    if (this.distinct) out = [...new Map(out.map((row) => [JSON.stringify(row), row])).values()];
    return out.slice(this.skip, this.skip + this.cap);
  }

  then<A = unknown[], B = never>(
    onfulfilled?: ((value: unknown[]) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve()
      .then(() => this.resolve())
      .then(onfulfilled, onrejected);
  }

  catch<B = never>(onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null): PromiseLike<unknown[] | B> {
    return this.then(undefined, onrejected);
  }
}

class WriteQuery implements PromiseLike<Row[]> {
  constructor(
    private readonly record: WriteRecord,
    private readonly nextId: () => number,
    private readonly matching: (predicate: unknown) => Row[],
    private readonly commit: (written: readonly Row[], matched: readonly Row[]) => void,
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

  private written(): Row[] {
    const values = this.record.values;
    if (this.record.verb === "insert") {
      const list: unknown[] = Array.isArray(values) ? values : [values];
      const inserted = list.map((item) => ({ id: this.nextId(), ...(typeof item === "object" && item !== null ? item : {}) }));
      this.commit(inserted, []);
      return inserted;
    }
    const matched = this.matching(this.record.where);
    const written =
      this.record.verb === "delete"
        ? matched
        : matched.map((row) => ({ ...row, ...(typeof values === "object" && values !== null ? values : {}) }));
    this.commit(written, matched);
    return written;
  }

  then<A = Row[], B = never>(
    onfulfilled?: ((value: Row[]) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve()
      .then(() => this.written())
      .then(onfulfilled, onrejected);
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

interface RelationalOptions {
  readonly where?: unknown;
  readonly columns?: Readonly<Record<string, boolean>>;
  readonly orderBy?: unknown;
  readonly limit?: number;
  readonly with?: unknown;
  readonly extras?: unknown;
}

const ADVISORY_LOCK = /^\s*select\s+pg_advisory_xact_lock\s*\(/i;
const SET_CONFIG = /set_config\('([a-z_.]+)',\s*\$(\d+),\s*(?:true|false)\)/gi;

function placeheld(node: unknown, params: unknown[]): string {
  if (is(node, SQL)) return node.queryChunks.map((chunk) => placeheld(chunk, params)).join("");
  if (is(node, StringChunk)) return node.value.join("");
  if (Array.isArray(node)) return node.map((item) => placeheld(item, params)).join(", ");
  if (is(node, Column)) throw new UnsupportedQuery(`column ${node.name} inside an executed statement`);
  params.push(is(node, Param) ? node.value : node);
  return `$${params.length - 1}`;
}

const RAW_SELECT =
  /^\s*select\s+([a-z_]+)\s+as\s+"(\w+)"\s+from\s+\$(\d+)\s+where\s+([\s\S]+?)\s+order\s+by\s+([a-z_]+)\s+(asc|desc)\s+limit\s+(\d+)\s*$/i;
const RAW_CONDITION = /^([a-z_]+)\s*=\s*(?:\$(\d+)|'([^']*)')$/i;

function rawSelect(statement: unknown, store: WorldRows): Row[] | null {
  const params: unknown[] = [];
  const text = placeheld(statement, params);
  const match = RAW_SELECT.exec(text);
  if (match === null) return null;
  const [, column, alias, tableIndex, where, orderColumn, direction, limit] = match;
  const table = params[Number(tableIndex)];
  if (!is(table, Table)) throw new UnsupportedQuery(`raw select source in "${text.slice(0, 120)}"`);
  const conditions: Array<readonly [string, unknown]> = where.split(/\s+and\s+/i).map((clause) => {
    const parsed = RAW_CONDITION.exec(clause.trim());
    if (parsed === null) throw new UnsupportedQuery(`raw select condition "${clause.trim()}"`);
    return [parsed[1], parsed[2] === undefined ? parsed[3] : params[Number(parsed[2])]];
  });
  const subselect = subselectOver(store);
  const keys = subselect(getTableName(table), orderColumn, conditions);
  const values = subselect(getTableName(table), column, conditions);
  const order = values
    .map((value, index) => ({ value, key: keys[index] }))
    .sort((left, right) => (direction.toLowerCase() === "desc" ? -1 : 1) * compareRows(left.key, right.key));
  return order.slice(0, Number(limit)).map(({ value }) => ({ [alias]: value }));
}

function gucSettings(statement: unknown): Record<string, string> | null {
  const params: unknown[] = [];
  const text = placeheld(statement, params);
  if (!/^\s*select\s+set_config\(/i.test(text)) return null;
  const settings: Record<string, string> = {};
  const rest = text.replace(SET_CONFIG, (_match, name: string, index: string) => {
    settings[name] = String(params[Number(index)]);
    return "";
  });
  if (rest.replace(/select|,|\s/gi, "") !== "") throw new UnsupportedQuery(`execute "${text.slice(0, 120)}"`);
  return settings;
}

export function worldDb(rows: WorldRows, options: { readonly mutable?: boolean } = {}): WorldDb {
  const store = new Map<Table, Row[]>([...rows].map(([table, list]) => [table, [...list]]));
  const settings: Array<Readonly<Record<string, string>>> = [];
  const writes: WriteRecord[] = [];
  const reads: ReadRecord[] = [];
  let sequence = 10_000;
  const nextId = (): number => {
    sequence += 1;
    return sequence;
  };
  const rowsOf = (table: Table, predicate: unknown): Row[] =>
    (store.get(table) ?? []).filter((row) => evaluate(predicate, lookupIn(new Map([[table, row]])), subselectOver(store)) === true);
  const apply = (table: Table, verb: WriteRecord["verb"], written: readonly Row[], matched: readonly Row[]): void => {
    if (options.mutable !== true) return;
    const current = store.get(table) ?? [];
    if (verb === "insert") store.set(table, [...current, ...written]);
    else if (verb === "delete") store.set(table, current.filter((row) => !matched.includes(row)));
    else store.set(table, current.map((row) => written[matched.indexOf(row)] ?? row));
  };
  const write = (verb: WriteRecord["verb"], table: unknown): WriteQuery => {
    const known = knownTable(table);
    const record: WriteRecord = { verb, table: getTableName(known), values: undefined, where: undefined };
    writes.push(record);
    return new WriteQuery(
      record,
      nextId,
      (predicate) => rowsOf(known, predicate),
      (written, matched) => apply(known, verb, written, matched),
    );
  };
  const relational = (table: Table) => {
    const find = (options: RelationalOptions = {}): Row[] => {
      if (typeof options.where === "function") throw new UnsupportedQuery(`callback where on ${getTableName(table)}`);
      if (options.with !== undefined || options.extras !== undefined) throw new UnsupportedQuery(`relational with/extras on ${getTableName(table)}`);
      if (options.orderBy !== undefined) throw new UnsupportedQuery(`relational orderBy on ${getTableName(table)}`);
      reads.push({ table: getTableName(table), where: options.where });
      const found = rowsOf(table, options.where).slice(0, options.limit ?? Number.POSITIVE_INFINITY);
      const columns = options.columns;
      if (columns === undefined) return found.map((row) => ({ ...row }));
      return found.map((row) =>
        Object.fromEntries(
          Object.entries(columns)
            .filter(([, wanted]) => wanted)
            .map(([key]) => {
              if (!(key in row)) throw new UnsupportedQuery(`fixture row of ${getTableName(table)} has no ${key} column the query projects`);
              return [key, row[key]];
            }),
        ),
      );
    };
    return {
      findFirst: async (options?: RelationalOptions): Promise<Row | undefined> => find({ ...options, limit: 1 })[0],
      findMany: async (options?: RelationalOptions): Promise<Row[]> => find(options),
    };
  };
  const query: Record<string, ReturnType<typeof relational>> = {};
  for (const [key, value] of Object.entries(schema)) if (is(value, Table)) query[key] = relational(value);

  const fake = {
    query,
    select: (fields?: unknown) => new SelectQuery(store, reads, fields, false),
    selectDistinct: (fields?: unknown) => new SelectQuery(store, reads, fields, true),
    insert: (table: unknown) => write("insert", table),
    update: (table: unknown) => write("update", table),
    delete: (table: unknown) => write("delete", table),
    execute: async (statement: unknown): Promise<Row[]> => {
      const text = sqlText(statement);
      if (ADVISORY_LOCK.test(text)) return [];
      const guc = gucSettings(statement);
      if (guc !== null) {
        settings.push(guc);
        return [{}];
      }
      reads.push({ table: "execute", where: statement });
      const selected = rawSelect(statement, store);
      if (selected !== null) return selected;
      throw new UnsupportedQuery(`execute "${text.slice(0, 120)}"`);
    },
    transaction: async <T>(work: (tx: object) => Promise<T>): Promise<T> => work(fake),
  };
  return { db: standIn<Db>(fake), tx: standIn<TenantTx>(fake), rows: store, writes, reads, settings };
}
