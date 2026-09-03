import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import {
  getPostgresErrorDetails,
  isCheckViolation,
  isExclusionViolation,
  isForeignKeyViolation,
  isNotNullViolation,
  isUniqueViolation,
  isUniqueViolationOn,
} from "src/common/db/postgres-error";
import { assertDisposableDatabase } from "test/helpers/disposable-database";

/**
 * Ground truth for every SQLSTATE check in the tree, taken from a real database
 * rather than from a fixture. Each case provokes an actual constraint violation
 * through Drizzle and asserts two things: that the shared helper reads it, and
 * that the three idioms this repository used instead — `err.code`,
 * `err.message.includes("23505")` and `err.constraint` — are all false against
 * the same error. A unit test can assert the first; only a real driver can
 * prove the second, which is why the dead checks survived review for so long.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const TABLE = "pgerr_probe";
const PARENT = "pgerr_probe_parent";

type Caught = { error: unknown };

describe("SQLSTATE classification against a real driver", () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;

  const capture = async (statement: string): Promise<Caught> => {
    try {
      await db.execute(sql.raw(statement));
    } catch (error) {
      return { error };
    }
    throw new Error(`expected "${statement}" to raise`);
  };

  beforeAll(async () => {
    const target = assertDisposableDatabase(DATABASE_URL);
    if (!target.ok) throw new Error(`[pgerr] ${target.reason}`);

    client = postgres(DATABASE_URL, { prepare: false, max: 2, onnotice: () => {} });
    db = drizzle(client, { schema: {} });

    await client.unsafe(`
      DROP TABLE IF EXISTS ${TABLE};
      DROP TABLE IF EXISTS ${PARENT};
      CREATE EXTENSION IF NOT EXISTS btree_gist;
      CREATE TABLE ${PARENT} (id text PRIMARY KEY);
      CREATE TABLE ${TABLE} (
        id text PRIMARY KEY,
        parent_id text NOT NULL REFERENCES ${PARENT}(id),
        org_id text NOT NULL,
        qty integer NOT NULL,
        window_start integer NOT NULL,
        window_end integer NOT NULL,
        CONSTRAINT pgerr_probe_qty_positive CHECK (qty > 0),
        CONSTRAINT pgerr_probe_no_overlap EXCLUDE USING gist (
          org_id WITH =, int4range(window_start, window_end) WITH &&
        )
      );
      CREATE UNIQUE INDEX uniq_pgerr_probe_org_qty ON ${TABLE} (org_id, qty);
      INSERT INTO ${PARENT}(id) VALUES ('p1');
      INSERT INTO ${TABLE} VALUES ('a', 'p1', 'o1', 1, 0, 10);
    `);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.unsafe(`DROP TABLE IF EXISTS ${TABLE}; DROP TABLE IF EXISTS ${PARENT};`);
      await client.end({ timeout: 5 });
    }
  });

  it("puts the SQLSTATE on the cause and nothing usable on the wrapper", async () => {
    const { error } = await capture(
      `INSERT INTO ${TABLE} VALUES ('b', 'p1', 'o1', 1, 20, 30)`,
    );

    expect(error).toBeInstanceOf(Error);
    expect(Reflect.get(error as object, "code")).toBeUndefined();
    expect((error as Error).message).not.toContain("23505");
    expect((error as Error).message).not.toContain("uniq_pgerr_probe_org_qty");
    expect(Reflect.get(error as object, "constraint")).toBeUndefined();

    const cause = Reflect.get(error as object, "cause");
    expect(Reflect.get(cause as object, "code")).toBe("23505");
    expect(Reflect.get(cause as object, "constraint_name")).toBe("uniq_pgerr_probe_org_qty");
    expect(Reflect.get(cause as object, "constraint")).toBeUndefined();
  });

  it("classifies a unique violation and names the index that raised it", async () => {
    const { error } = await capture(
      `INSERT INTO ${TABLE} VALUES ('c', 'p1', 'o1', 1, 40, 50)`,
    );

    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolationOn(error, "uniq_pgerr_probe_org_qty")).toBe(true);
    expect(isUniqueViolationOn(error, "a_different_index")).toBe(false);
    expect(getPostgresErrorDetails(error)).toMatchObject({
      code: "23505",
      constraint: "uniq_pgerr_probe_org_qty",
      table: TABLE,
    });
  });

  it("classifies a foreign key violation", async () => {
    const { error } = await capture(
      `INSERT INTO ${TABLE} VALUES ('d', 'missing', 'o2', 1, 0, 10)`,
    );

    expect(isForeignKeyViolation(error)).toBe(true);
    expect(getPostgresErrorDetails(error).constraint).toBe("pgerr_probe_parent_id_fkey");
  });

  it("classifies a not-null violation and names the column", async () => {
    const { error } = await capture(
      `INSERT INTO ${TABLE} VALUES ('e', 'p1', 'o2', NULL, 0, 10)`,
    );

    expect(isNotNullViolation(error)).toBe(true);
    expect(getPostgresErrorDetails(error)).toMatchObject({ table: TABLE, column: "qty" });
  });

  it("classifies a check violation", async () => {
    const { error } = await capture(
      `INSERT INTO ${TABLE} VALUES ('f', 'p1', 'o2', -1, 0, 10)`,
    );

    expect(isCheckViolation(error)).toBe(true);
    expect(getPostgresErrorDetails(error).constraint).toBe("pgerr_probe_qty_positive");
  });

  it("classifies an exclusion violation", async () => {
    const { error } = await capture(
      `INSERT INTO ${TABLE} VALUES ('g', 'p1', 'o1', 99, 5, 15)`,
    );

    expect(isExclusionViolation(error)).toBe(true);
    expect(getPostgresErrorDetails(error).constraint).toBe("pgerr_probe_no_overlap");
  });

  it("classifies a violation raised inside a transaction the same way", async () => {
    let caught: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`INSERT INTO ${TABLE} VALUES ('h', 'p1', 'o1', 1, 60, 70)`));
      });
    } catch (error) {
      caught = error;
    }

    expect(isUniqueViolation(caught)).toBe(true);
    expect(Reflect.get(caught as object, "code")).toBeUndefined();
  });
});
