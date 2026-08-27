/**
 * Live-catalogue parity for the inventory schema — INV-103 / Phase 1 gate.
 *
 * The audit found 18 columns that exist in Postgres and not in TypeScript:
 * `org_id` on fifteen line tables and `client_party_id` on three documents,
 * installed by migrations 0320-0323 and maintained by `BEFORE INSERT` triggers.
 * Drizzle could not see any of them, so `db:generate` would have proposed
 * dropping them along with the 86 composite tenant foreign keys that depend on
 * them, and no ORM query could filter tenant at the line grain.
 *
 * Guarded by INV_DB_TESTS=1 like the other real-database inventory specs:
 *   INV_DB_TESTS=1 npx jest --runInBand --testPathPattern="inventory-schema-parity"
 */
import dotenv from "dotenv";
import postgres from "postgres";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as inventorySchema from "../../../db/schema/inventory";

const ENABLED = process.env.INV_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

interface LiveColumn {
  table_name: string;
  column_name: string;
  is_nullable: "YES" | "NO";
}

function declaredTables(): Map<string, ReturnType<typeof getTableConfig>> {
  const out = new Map<string, ReturnType<typeof getTableConfig>>();
  for (const value of Object.values(inventorySchema)) {
    let config: ReturnType<typeof getTableConfig>;
    try {
      config = getTableConfig(value as PgTable);
    } catch {
      continue;
    }
    if (config.name.startsWith("inv_")) out.set(config.name, config);
  }
  return out;
}

describeDb("inventory schema parity with the live catalogue", () => {
  let sql: ReturnType<typeof postgres>;
  let liveColumns: LiveColumn[];
  let liveTables: Map<string, Map<string, LiveColumn>>;
  const drizzle = declaredTables();

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL required for INV_DB_TESTS");
    sql = postgres(url, { prepare: false, max: 1, onnotice: () => undefined });
    liveColumns = await sql<LiveColumn[]>`
      SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name LIKE 'inv\\_%'`;
    liveTables = new Map();
    for (const column of liveColumns) {
      const existing = liveTables.get(column.table_name) ?? new Map<string, LiveColumn>();
      existing.set(column.column_name, column);
      liveTables.set(column.table_name, existing);
    }
  });

  afterAll(async () => {
    await sql?.end();
  });

  it("declares every live inventory table and no phantom ones", () => {
    const live = [...liveTables.keys()].sort();
    const declared = [...drizzle.keys()].sort();
    expect(declared.filter((t) => !liveTables.has(t))).toEqual([]);
    expect(live.filter((t) => !drizzle.has(t))).toEqual([]);
  });

  it("declares every live column, so no generated migration can propose a drop", () => {
    const missing: string[] = [];
    for (const [table, config] of drizzle) {
      const columns = liveTables.get(table);
      if (!columns) continue;
      const declared = new Set(config.columns.map((c) => c.name));
      for (const name of columns.keys()) if (!declared.has(name)) missing.push(`${table}.${name}`);
    }
    expect(missing).toEqual([]);
  });

  it("declares no column the live catalogue does not have", () => {
    const extra: string[] = [];
    for (const [table, config] of drizzle) {
      const columns = liveTables.get(table);
      if (!columns) continue;
      for (const column of config.columns) if (!columns.has(column.name)) extra.push(`${table}.${column.name}`);
    }
    expect(extra).toEqual([]);
  });

  it("agrees with the live catalogue on nullability", () => {
    const mismatched: string[] = [];
    for (const [table, config] of drizzle) {
      const columns = liveTables.get(table);
      if (!columns) continue;
      for (const column of config.columns) {
        const live = columns.get(column.name);
        if (!live) continue;
        const liveNotNull = live.is_nullable === "NO";
        if (column.notNull !== liveNotNull)
          mismatched.push(`${table}.${column.name} (drizzle notNull=${String(column.notNull)}, live notNull=${String(liveNotNull)})`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("gives every inventory table a declared tenant column", () => {
    const untenanted = [...drizzle.entries()]
      .filter(([, config]) => !config.columns.some((c) => c.name === "org_id"))
      .map(([table]) => table);
    expect(untenanted).toEqual([]);
  });

  it("enables row-level security with a tenant policy on every inventory table", async () => {
    const rows = await sql<{ table_name: string; rls: boolean; policies: number }[]>`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'inv\\_%'`;
    expect(rows.filter((r) => !r.rls).map((r) => r.table_name)).toEqual([]);
    expect(rows.filter((r) => r.policies === 0).map((r) => r.table_name)).toEqual([]);
  });

  it("keeps a composite tenant key on every line table that carries one live", async () => {
    const rows = await sql<{ tbl: string; conname: string }[]>`
      SELECT rel.relname AS tbl, con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname = 'public' AND rel.relname LIKE 'inv\\_%'
        AND con.contype = 'u' AND con.conname LIKE 'uniq\\_%\\_org\\_id'`;
    const missing: string[] = [];
    for (const row of rows) {
      const config = drizzle.get(row.tbl);
      if (!config) continue;
      const declared = config.uniqueConstraints.some((u) => u.name === row.conname);
      if (!declared) missing.push(`${row.tbl}.${row.conname}`);
    }
    expect(missing).toEqual([]);
  });
});
