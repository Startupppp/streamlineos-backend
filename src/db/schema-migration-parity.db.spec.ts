import * as schema from "./schema";
import postgres from "postgres";
import dotenv from "dotenv";

/**
 * Does the database this schema declares actually exist after `db:bootstrap`?
 *
 * PEND-DB got `pnpm db:bootstrap` to `REACHED_HEAD` from an empty database for
 * the first time. Reaching head is not the same claim as "the app can run": a
 * migration series can complete and still leave out a table nothing ever
 * migrated, because `drizzle-kit push` created it on the databases anybody
 * looked at. `client_party_id` was exactly that, three times over, and it is
 * what stopped the cold build at `0575`.
 *
 * So this compares every `pgTable` in `src/db/schema/` against the connected
 * database and names what is missing. Run it against a **cold-built** database —
 * one produced by `createdb` + extensions + `pnpm db:bootstrap` and nothing
 * else. Run against a `push`-touched database it proves nothing, because push
 * is what hides the gap.
 *
 *   createdb cornerstone_cold
 *   psql -d cornerstone_cold -c "CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;
 *     CREATE EXTENSION btree_gist; CREATE EXTENSION pgcrypto; CREATE EXTENSION \"uuid-ossp\";"
 *   DATABASE_URL=postgres://<you>@localhost:5432/cornerstone_cold pnpm db:bootstrap
 *   INV_DB_TESTS=1 DATABASE_URL=postgres://<you>@localhost:5432/cornerstone_cold \
 *     npx jest --runInBand --testPathPattern=schema-migration-parity
 *
 * Gated behind `INV_DB_TESTS` like the RLS probes, for the same reason: it needs
 * a real database and it is not the unit suite's job to have one.
 */

const ENABLED = process.env.INV_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

const SCHEMAS = ["public", "build", "build_events", "app"] as const;

/**
 * Declared tables that **no migration creates**, and what it would take.
 *
 * A name and a sentence, never a bare list. This is the same exemption shape
 * `inventory-schema-reachability.spec.ts` and `cold-build-integrity.spec.ts`
 * use, and it is here so the gap is a number somebody has to look at rather
 * than a surprise at the end of a build.
 */
const NOT_MIGRATED: ReadonlyArray<{ table: string; reason: string }> = [
  ...[
    "billing_credit_note_lines",
    "billing_credit_notes",
    "billing_invoice_line_snapshots",
    "billing_invoice_number_sequences",
    "billing_invoice_snapshots",
    "billing_plan_entitlements",
    "billing_plans",
    "billing_price_versions",
    "billing_products",
    "billing_proration_lines",
    "billing_seat_events",
    "billing_usage_events",
    "billing_usage_reservations",
    "billing_usage_rollups",
    "org_entitlement_overrides",
    "subscription_items",
  ].map((table) => ({
    table: `public.${table}`,
    reason:
      "Declared in src/db/schema/billing/ and created by no migration in this repository — it " +
      "exists on the shared branch because drizzle-kit push made it. The gap is larger than the " +
      "table: the sixteen carry 12 RLS policies, 4 immutability triggers and the 4 " +
      "enforce_billing_*_immutability functions those triggers call, and none of that is " +
      "migrated either. Writing it means transcribing a live schema — including tenant isolation " +
      "policies — into a migration, which is billing's owner's call and not a mechanical one. " +
      "Until then a cold-built database has every other declared table and none of these.",
  })),
];

interface Missing {
  tables: string[];
  columns: string[];
}

async function compare(url: string): Promise<Missing> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    const live = new Map<string, Set<string>>();
    for (const row of await sql<
      { table_schema: string; table_name: string; column_name: string }[]
    >`SELECT table_schema, table_name, column_name FROM information_schema.columns
       WHERE table_schema = ANY(${SCHEMAS as unknown as string[]})`) {
      const key = `${row.table_schema}.${row.table_name}`;
      if (!live.has(key)) live.set(key, new Set());
      live.get(key)!.add(row.column_name);
    }

    const tables: string[] = [];
    const columns: string[] = [];
    for (const value of Object.values(schema)) {
      const symbols = Object.getOwnPropertySymbols(value ?? {});
      const nameSym = symbols.find((s) => String(s).includes("drizzle:Name"));
      if (!nameSym) continue;
      const table = value as Record<symbol, unknown>;
      const schemaSym = symbols.find((s) => String(s).includes("drizzle:Schema"));
      const ns = (schemaSym && (table[schemaSym] as string | undefined)) || "public";
      const key = `${ns}.${table[nameSym] as string}`;

      const have = live.get(key);
      if (!have) {
        tables.push(key);
        continue;
      }
      const colsSym = symbols.find((s) => String(s).includes("drizzle:Columns"));
      const cols = (table[colsSym!] ?? {}) as Record<string, { name: string }>;
      for (const col of Object.values(cols)) {
        if (!have.has(col.name)) columns.push(`${key}.${col.name}`);
      }
    }
    return { tables: tables.sort(), columns: columns.sort() };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describeDb("the declared schema exists in the database", () => {
  let missing: Missing;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL required for INV_DB_TESTS");
    missing = await compare(url);
  }, 120_000);

  it("finds the schema at all, so a broken walk cannot pass silently", () => {
    const declared = Object.values(schema).filter((v) =>
      Object.getOwnPropertySymbols(v ?? {}).some((s) => String(s).includes("drizzle:Name")),
    );
    expect(declared.length).toBeGreaterThan(800);
  });

  it("declares no column the migrations do not create", () => {
    // The failure mode that stopped the cold build at 0575: a column declared
    // in drizzle, named by a foreign key, and created by nothing.
    expect(missing.columns).toEqual([]);
  });

  it("declares no table the migrations do not create, beyond the named exemptions", () => {
    const exempt = new Set(NOT_MIGRATED.map((e) => e.table));
    expect(missing.tables.filter((t) => !exempt.has(t))).toEqual([]);
  });

  it("does not let the exemption list quietly absorb a table that is now migrated", () => {
    // An exemption that has been fixed should be deleted, not left standing —
    // otherwise the list stops meaning "these are missing" and starts meaning
    // "nobody has looked".
    const stillMissing = new Set(missing.tables);
    expect(NOT_MIGRATED.map((e) => e.table).filter((t) => !stillMissing.has(t))).toEqual([]);
  });

  it("gives every exemption a reason somebody can read", () => {
    for (const { table, reason } of NOT_MIGRATED) {
      expect(table).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(reason.length).toBeGreaterThan(120);
    }
  });
});
