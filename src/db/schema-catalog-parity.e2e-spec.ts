import postgres from "postgres";
import { requiresTls } from "./pool.config";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema";

/**
 * The Drizzle schema is the source of truth, but nothing enforced that the
 * database had caught up with it. Ten tables had drifted — including the whole
 * canonical person model — and every read projecting a full row died 42703
 * against them, which took clocking in and time off down for every organisation
 * without a single test noticing. This is the check that would have caught it:
 * a column declared here and absent there is a runtime failure waiting for its
 * first caller.
 */
const TRACKED_SCHEMAS = ["public", "build", "build_events", "app"];

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("channel_binding");
    return parsed.toString();
  } catch {
    return url;
  }
}

const d = process.env.DATABASE_URL ? describe : describe.skip;

d("schema ↔ catalog parity", () => {
  let sql: ReturnType<typeof postgres>;
  let live: Map<string, Set<string>>;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL required");
    /**
     * TLS follows the host, rather than being demanded of every one.
     *
     * `ssl: "require"` is right for the managed database this was written
     * against and impossible for a local one, which does not speak it — the
     * connection fails while the query is still being built, so the suite does
     * not fail, it fails to run. `requiresTls` is the rule the application's own
     * pool applies, so this connects on the same terms the code under test does.
     */
    sql = postgres(normalizeUrl(url), {
      prepare: false,
      max: 2,
      ...(requiresTls(url) ? { ssl: "require" as const } : {}),
    });

    const rows = await sql<{ table_schema: string; table_name: string; column_name: string }[]>`
      SELECT table_schema, table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = ANY(${TRACKED_SCHEMAS})
    `;
    live = new Map();
    for (const row of rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      const cols = live.get(key) ?? new Set<string>();
      cols.add(row.column_name);
      live.set(key, cols);
    }
  }, 60_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it("every table the schema declares exists in the database", () => {
    const missing: string[] = [];
    for (const value of Object.values(schema)) {
      if (!value || typeof value !== "object" || !is(value, PgTable)) continue;
      const cfg = getTableConfig(value);
      const key = `${cfg.schema ?? "public"}.${cfg.name}`;
      if (!live.has(key)) missing.push(key);
    }
    expect(missing).toEqual([]);
  });

  it("every column the schema declares exists on its table", () => {
    const drifted: string[] = [];
    for (const value of Object.values(schema)) {
      if (!value || typeof value !== "object" || !is(value, PgTable)) continue;
      const cfg = getTableConfig(value);
      const key = `${cfg.schema ?? "public"}.${cfg.name}`;
      const actual = live.get(key);
      if (!actual) continue;
      const absent = cfg.columns.map((c) => c.name).filter((name) => !actual.has(name));
      if (absent.length) drifted.push(`${key}: ${absent.join(", ")}`);
    }
    expect(drifted).toEqual([]);
  });
});
