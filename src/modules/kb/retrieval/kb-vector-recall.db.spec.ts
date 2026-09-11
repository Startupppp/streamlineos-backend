/**
 * Real-database proof that KB vector retrieval hands back the pool it was asked for.
 *
 * Run via `pnpm test:db-specs` (uses jest-db.json, which selects *.db.spec.ts only).
 * The default hermetic jest config ignores this file entirely.
 *
 *   APP_DATABASE_URL="postgresql://streamline_app:...@localhost:5432/scratch_head_1010" \
 *   DATABASE_URL="postgresql://tarunchintakunta@localhost:5432/scratch_head_1010" \
 *   PGSSLMODE=disable npx jest --config jest-db.json --runInBand --testPathPattern="kb-vector-recall.db"
 *
 * WHY A REAL DATABASE. `kb-hnsw-iterative-scan.spec.ts` mocks `db.execute` and matches the
 * SQL text. It certifies that the `SET LOCAL hnsw.iterative_scan` statement is *issued*; it
 * cannot see how many rows come back, so it stayed green while `vectorChunkIds` returned 50
 * of the 240 candidates it asked for on a 54,000-chunk table (target tenant 25,200 of them,
 * `Rows Removed by Filter: 1103`). Only Postgres can answer that question.
 *
 * WHY THE FIXTURE PINS TWO PLANNER SETTINGS. The failure needs the plan to be
 * `Index Scan using idx_kb_chunks_embedding_hnsw … Filter: (org_id = …)`, and the HNSW scan
 * to run out of tuples before `cap` of them have survived the tenant filter. In production
 * both happen on their own once the table is large enough (measured above, at pgvector
 * defaults). Reproducing that with a 54,000-row fixture is not something a spec can do, so
 * the fixture reaches the same boundary deliberately:
 *
 *   - `enable_sort = off` makes the planner pick the HNSW index at fixture size, which it
 *     does by itself at production size.
 *   - `hnsw.max_scan_tuples` is lowered below `cap`, which bounds the scan the way the
 *     graph's own exhaustion bounds it at production size.
 *
 * Neither GUC is set by the code under test; both are pgvector/planner knobs that exist
 * precisely to bound this scan. What the spec asserts is the invariant that holds at every
 * size: a short ANN pass must not be returned as if it were the answer.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import { createTenantAwareDb } from "../../../common/tenant/tenant-db";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";
import { KbCandidateService } from "./kb-candidate.service";

/** Chunks the target tenant owns. Must exceed CAP so a full pool is actually available. */
const TENANT_CHUNKS = 320;
/** Chunks belonging to a second tenant, so the org predicate has something to exclude. */
const OTHER_CHUNKS = 320;
/** What retrieval asks for. `pool * 4` in production; 240 in the measurement above. */
const CAP = 200;
/** Below CAP: the ANN pass cannot return a full pool however good the graph is. */
const SCAN_BOUND = 120;

const suffix = randomUUID().slice(0, 8);
const TENANT_ORG = `kbrecall-a-${suffix}`;
const OTHER_ORG = `kbrecall-b-${suffix}`;
const PROBE_USER = `kbrecall-user-${suffix}`;

function connect(url: string, max: number) {
  return postgres(url, { prepare: false, max, connect_timeout: 30 });
}

describe("KB vectorChunkIds — candidate pool recall against Postgres", () => {
  let owner: ReturnType<typeof postgres>;
  let appClient: ReturnType<typeof postgres>;
  let appDb: ReturnType<typeof createTenantAwareDb>;
  let base: ReturnType<typeof drizzle<typeof schema>>;
  let service: KbCandidateService;
  let queryVector: string;

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL;
    const appUrl = process.env.APP_DATABASE_URL;
    if (!ownerUrl || !appUrl)
      throw new Error("kb-vector-recall.db.spec.ts requires DATABASE_URL (owner, seeds) and APP_DATABASE_URL (RLS role)");

    owner = connect(ownerUrl, 2);
    appClient = connect(appUrl, 2);
    base = drizzle(appClient, { schema });
    appDb = createTenantAwareDb(Object.assign(base, { __client: appClient }));
    service = new KbCandidateService(appDb);

    // Two organisations sharing one HNSW index — the production shape. The
    // organizations ⇄ organization_members foreign key is circular and DEFERRABLE,
    // so both sides go in inside one transaction.
    await owner.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`INSERT INTO users (id, email, name) VALUES (${PROBE_USER}, ${`${PROBE_USER}@kb-recall.invalid`}, 'KB recall probe')`;
      // Only organizations → organization_members is deferrable, so the organisation goes
      // in first pointing at an owner membership that does not exist yet, the memberships
      // take sequence-assigned ids (a hard-coded one collides on a re-run after an
      // interrupted teardown), and the pointer is corrected before commit.
      await tx`
        INSERT INTO organizations (id, name, slug, owner_membership_id) VALUES
          (${TENANT_ORG}, 'KB recall tenant', ${TENANT_ORG}, 0),
          (${OTHER_ORG}, 'KB recall other', ${OTHER_ORG}, 0)`;
      const members = await tx<{ id: number; org_id: string }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner) VALUES
          (${PROBE_USER}, ${TENANT_ORG}, 'OWNER', true),
          (${PROBE_USER}, ${OTHER_ORG}, 'OWNER', true)
        RETURNING id, org_id`;
      for (const member of members)
        await tx`UPDATE organizations SET owner_membership_id = ${member.id} WHERE id = ${member.org_id}`;
    });

    // Deterministic 1536-dimension vectors: cyclic rotations of one sinusoid, so every
    // row is distinct, the fixture is reproducible, and seeding stays a single statement.
    await owner`
      WITH b AS (
        SELECT array_agg(sin(i * 0.7)::real ORDER BY i) AS v FROM generate_series(1, 1536) i
      )
      INSERT INTO kb_article_chunks (org_id, source, chunk_index, content, embedding, embedding_model, acl_revision)
      SELECT
        CASE WHEN g <= ${TENANT_CHUNKS} THEN ${TENANT_ORG} ELSE ${OTHER_ORG} END,
        'article', g, 'kb recall probe ' || g,
        (b.v[(g % 1536) + 1 : 1536] || b.v[1 : (g % 1536)])::vector(1536),
        'text-embedding-3-small', 1
      FROM generate_series(1, ${TENANT_CHUNKS + OTHER_CHUNKS}) AS s(g) CROSS JOIN b`;

    const [row] = await owner<{ v: string }[]>`
      SELECT embedding::text AS v FROM kb_article_chunks WHERE org_id = ${TENANT_ORG} ORDER BY id LIMIT 1`;
    if (!row) throw new Error("fixture seeded no chunks");
    queryVector = row.v;
  }, 180_000);

  afterAll(async () => {
    if (owner) {
      await owner`DELETE FROM kb_article_chunks WHERE org_id IN (${TENANT_ORG}, ${OTHER_ORG})`;
      // Deleting the organisation first is deliberate: `trg_guard_owner_membership`
      // refuses a direct delete of the owner membership, but the cascade from
      // `organizations` runs after the parent row is gone, so the guard finds no
      // owner pointer and lets the membership go.
      await owner`DELETE FROM organizations WHERE id IN (${TENANT_ORG}, ${OTHER_ORG})`;
      await owner`DELETE FROM users WHERE id = ${PROBE_USER}`;
      await owner.end({ timeout: 5 });
    }
    if (appClient) await appClient.end({ timeout: 5 });
  }, 60_000);

  /**
   * Runs `fn` the way a request does: inside one tenant transaction, with the GUC set and
   * the tenant context installed, so `KbCandidateService`'s injected `db` routes its
   * `SET LOCAL` and its query to the same connection. Rolled back afterwards.
   */
  async function inTenantTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const sentinel = new Error("rollback");
    // A one-element array rather than a `let … | null`: the assignment happens inside a
    // callback TypeScript's control flow cannot follow, so the nullable form narrowed to
    // `never` after the try and `captured.value` did not compile.
    const captured: { value: T }[] = [];
    try {
      await base.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.organization_id', ${TENANT_ORG}, true)`);
        // `enable_sort = off` leaves the HNSW index as the only way to satisfy
        // `ORDER BY embedding <=> …`, which is the plan production reaches by cost
        // once the table is large. The exact second pass still sorts — it is fenced
        // behind `OFFSET 0`, so no index can order it and a (penalised) Sort is the
        // only plan available, which is exactly what must happen here.
        await tx.execute(sql.raw("SET LOCAL enable_sort = off"));
        await tx.execute(sql.raw(`SET LOCAL hnsw.max_scan_tuples = ${SCAN_BOUND}`));
        captured.push({
          value: await runWithTenantContext({ orgId: TENANT_ORG, audience: "INTERNAL", tx }, fn),
        });
        throw sentinel;
      });
    } catch (err) {
      if (err !== sentinel) throw err;
    }
    const result = captured[0];
    if (!result) throw new Error("transaction body did not run");
    return result.value;
  }

  it("the plan under test is the HNSW index scan with the tenant predicate as a filter", async () => {
    const plan = await inTenantTransaction(async () => {
      const rows = await appDb.execute(
        sql`EXPLAIN (FORMAT TEXT) SELECT id FROM public.kb_article_chunks
            WHERE org_id = ${TENANT_ORG}
            ORDER BY embedding <=> ${queryVector}::vector LIMIT ${CAP}`,
      );
      return rows.map((r) => String(r["QUERY PLAN"])).join("\n");
    });
    expect(plan).toContain("idx_kb_chunks_embedding_hnsw");
  }, 120_000);

  it("returns the full candidate pool when the tenant has more chunks than the cap", async () => {
    const ids = await inTenantTransaction(() =>
      service.vectorChunkIds(TENANT_ORG, queryVector, CAP),
    );
    expect(ids).toHaveLength(CAP);
  }, 120_000);

  it("returns the tenant's true nearest chunks, not whatever the truncated ANN pass reached", async () => {
    const { ids, groundTruth } = await inTenantTransaction(async () => {
      const actual = await service.vectorChunkIds(TENANT_ORG, queryVector, CAP);
      const exact = await appDb.execute(
        sql`SELECT id FROM (
              SELECT id, embedding <=> ${queryVector}::vector AS distance
              FROM public.kb_article_chunks WHERE org_id = ${TENANT_ORG} OFFSET 0
            ) scoped ORDER BY scoped.distance LIMIT ${CAP}`,
      );
      return { ids: actual, groundTruth: exact.map((r) => Number(r["id"])) };
    });
    expect(groundTruth).toHaveLength(CAP);
    expect([...ids].sort((a, b) => a - b)).toEqual([...groundTruth].sort((a, b) => a - b));
  }, 120_000);

  it("never returns another tenant's chunk ids", async () => {
    const ids = await inTenantTransaction(() =>
      service.vectorChunkIds(TENANT_ORG, queryVector, CAP),
    );
    const foreign = await owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kb_article_chunks
      WHERE id = ANY(${ids}) AND org_id <> ${TENANT_ORG}`;
    expect(foreign[0]?.n).toBe(0);
  }, 120_000);

  it("returns every chunk the tenant has when the cap exceeds the corpus", async () => {
    const ids = await inTenantTransaction(() =>
      service.vectorChunkIds(TENANT_ORG, queryVector, TENANT_CHUNKS + 50),
    );
    expect(ids).toHaveLength(TENANT_CHUNKS);
  }, 120_000);
});
