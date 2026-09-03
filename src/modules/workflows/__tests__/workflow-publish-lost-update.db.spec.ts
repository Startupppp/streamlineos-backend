/**
 * Two editors publish the same workflow at the same time. One must lose.
 *
 * At head neither did. `publishWorkflow` read `workflows.version` OUTSIDE
 * `db.transaction`, compared it there, and then wrote with a predicate that
 * matched on id alone — a textbook TOCTOU. Three independent things had to be
 * true for the guard to bite and none of them were:
 *
 *   1. The only caller — `features/workflows/builder/workflow-builder-canvas.tsx`
 *      — sends `{ id, definitionJson }` and no `expectedVersion`.
 *   2. `expectedVersion` is `.optional()` and the check read
 *      `dto.expectedVersion !== undefined && …`, so an absent field skipped it.
 *   3. Even when supplied, the comparison happened before the transaction opened.
 *
 * And there is no database-level backstop: `workflow_versions` carries only
 * `workflow_versions_pkey`, `uniq_workflow_versions_org_id (org_id, id)`,
 * `idx_workflow_versions_org` and a PLAIN btree `idx_workflow_versions_workflow_version`
 * on (workflow_id, version) — nothing unique on (org_id, workflow_id, version).
 * So both editors inserted a version-4 row with different definitions, both got
 * 200, and whichever `workflows.version` update committed second decided which
 * definition was live. The canvas's own 409 handler ("Another user published a
 * newer version — refresh before publishing") could never fire.
 *
 * A mocked db cannot see any of this: the interleaving is decided by Postgres row
 * locks under READ COMMITTED. So this spec runs two genuine concurrent
 * transactions against a real catalog and asserts exactly one wins.
 *
 * Guarded by WORKFLOW_DB_TESTS=1 in the house `.db.spec.ts` style. Fixtures are
 * committed (concurrency needs two transactions, so a single rolled-back one
 * cannot express it) and removed again in `afterAll` — the org row cascades.
 *
 *   WORKFLOW_DB_TESTS=1 DATABASE_URL=postgresql://…/scratch_head_1010 PGSSLMODE=disable \
 *     npx jest --runInBand --testPathPattern="workflow-publish-lost-update.db"
 */
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import postgres from "postgres";

const ENABLED = process.env.WORKFLOW_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

if (ENABLED) jest.setTimeout(120_000);

function connect(): ReturnType<typeof postgres> {
  if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL required for WORKFLOW_DB_TESTS");
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const plaintext =
    process.env.PGSSLMODE === "disable" ||
    url.searchParams.get("sslmode") === "disable" ||
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1";
  return postgres(url.toString(), {
    prepare: false,
    max: 4,
    ssl: plaintext ? false : "require",
    connect_timeout: 30,
    onnotice: () => {},
  });
}

interface PublishOutcome {
  won: boolean;
  version: number | null;
}

describeDb("workflow publish — concurrent publishes, real database", () => {
  let sql: ReturnType<typeof postgres>;
  const orgId = `wf-cas-${randomUUID().slice(0, 12)}`;
  const userId = `wf-cas-user-${randomUUID().slice(0, 12)}`;
  let workflowId = "";

  beforeAll(async () => {
    sql = connect();
    await sql.begin(async (tx) => {
      // `organizations.owner_membership_id` -> `organization_members(org_id, id)`
      // and back again: the FK is DEFERRABLE INITIALLY DEFERRED precisely so the
      // cycle can be closed inside one transaction. A placeholder that is never
      // corrected only survives a ROLLBACK; this fixture commits.
      await tx`
        INSERT INTO organizations (id, name, slug, owner_membership_id)
        VALUES (${orgId}, ${"Workflow CAS Probe"}, ${orgId}, 0)
      `;
      await tx`INSERT INTO users (id, email) VALUES (${userId}, ${`${userId}@probe.invalid`})`;
      const [member] = await tx`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${userId}, ${orgId}, ${"OWNER"}, true)
        RETURNING id
      `;
      await tx`
        UPDATE organizations SET owner_membership_id = ${Number(member?.["id"])} WHERE id = ${orgId}
      `;
      const [row] = await tx`
        INSERT INTO workflows (org_id, name, status, version)
        VALUES (${orgId}, ${"CAS probe"}, ${"draft"}, 3)
        RETURNING id
      `;
      workflowId = String(row?.["id"]);
    });
  });

  afterAll(async () => {
    if (!sql) return;
    // `workflow_versions`, `workflows` and `organization_members` all cascade
    // from the org row; the probe user is global and has to go explicitly.
    await sql`DELETE FROM organizations WHERE id = ${orgId}`.catch(() => undefined);
    await sql`DELETE FROM users WHERE id = ${userId}`.catch(() => undefined);
    await sql.end({ timeout: 5 });
  });

  /**
   * The statement the service now issues: read the version inside the
   * transaction, then compare-and-set on it. `barrier` makes both transactions
   * read before either writes, which is the interleaving that produced the lost
   * update — without it the two would simply queue up and both look fine.
   */
  async function publish(definition: string, barrier: Promise<void>): Promise<PublishOutcome> {
    return sql.begin(async (tx) => {
      const [current] = await tx`
        SELECT version FROM workflows WHERE id = ${workflowId}::uuid AND org_id = ${orgId}
      `;
      const expected = Number(current?.["version"]);

      await barrier;

      const updated = await tx`
        UPDATE workflows
           SET version = ${expected + 1}, status = 'published', updated_at = now()
         WHERE id = ${workflowId}::uuid AND org_id = ${orgId} AND version = ${expected}
        RETURNING version
      `;
      if (updated.length === 0) return { won: false, version: null };

      await tx`
        INSERT INTO workflow_versions (org_id, workflow_id, version, definition_json)
        VALUES (${orgId}, ${workflowId}::uuid, ${expected + 1}, ${sql.json({ d: definition })})
      `;
      return { won: true, version: expected + 1 };
    });
  }

  it("exactly one of two simultaneous publishes wins; the other is refused", async () => {
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const both = Promise.all([publish("editor-a", barrier), publish("editor-b", barrier)]);
    // Both transactions are now parked after their read. Letting them go
    // together is what makes this a race rather than two sequential publishes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const [a, b] = await both;

    expect([a.won, b.won].filter(Boolean)).toHaveLength(1);
    expect([a.won, b.won].filter((won) => !won)).toHaveLength(1);
  });

  it("leaves exactly one version-4 row — not two rows racing to be the live definition", async () => {
    const rows = await sql`
      SELECT version, count(*)::int AS n
        FROM workflow_versions
       WHERE org_id = ${orgId} AND workflow_id = ${workflowId}::uuid
       GROUP BY version
    `;
    expect(rows).toEqual([{ version: 4, n: 1 }]);
  });

  it("advances workflows.version by exactly one, so the loser's write is not silently applied", async () => {
    const [row] = await sql`
      SELECT version, status FROM workflows WHERE id = ${workflowId}::uuid AND org_id = ${orgId}
    `;
    expect(row).toMatchObject({ version: 4, status: "published" });
  });

  it("(bite proof) the id-only predicate the service used to issue lets BOTH writes through", async () => {
    // Same interleaving, same two transactions — but matching on id alone, which
    // is exactly what shipped. Both succeed and the second overwrites the first,
    // which is the lost update. Run on a second workflow so the assertions above
    // keep their subject.
    const [seeded] = await sql`
      INSERT INTO workflows (org_id, name, status, version)
      VALUES (${orgId}, ${"bite probe"}, ${"draft"}, 3)
      RETURNING id
    `;
    const biteId = String(seeded?.["id"]);

    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const headForm = async (): Promise<boolean> =>
      sql.begin(async (tx) => {
        const [current] = await tx`
          SELECT version FROM workflows WHERE id = ${biteId}::uuid AND org_id = ${orgId}
        `;
        const expected = Number(current?.["version"]);
        await barrier;
        const updated = await tx`
          UPDATE workflows SET version = ${expected + 1}, status = 'published'
           WHERE id = ${biteId}::uuid AND org_id = ${orgId}
          RETURNING version
        `;
        return updated.length > 0;
      });

    const both = Promise.all([headForm(), headForm()]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const [a, b] = await both;

    expect(a).toBe(true);
    expect(b).toBe(true);
    const [row] = await sql`SELECT version FROM workflows WHERE id = ${biteId}::uuid`;
    // Two publishes, one version bump: the second read a stale 3 and wrote 4 on
    // top of the first's 4. That is the update that was lost.
    expect(Number(row?.["version"])).toBe(4);
  });
});
