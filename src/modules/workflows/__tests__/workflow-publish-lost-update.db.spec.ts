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
 * Fixtures are committed (concurrency needs two transactions, so a single
 * rolled-back one cannot express it) and removed again in `afterAll` — the org
 * row cascades. Run via `pnpm test:db-specs` (jest-db.json).
 */
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import postgres from "postgres";

jest.setTimeout(120_000);

function connect(): ReturnType<typeof postgres> {
  if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("workflow-publish-lost-update.db.spec.ts requires DATABASE_URL");
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
  /** What this transaction saw before the barrier — the proof the race really raced. */
  readVersion: number;
}

describe("workflow publish — concurrent publishes, real database", () => {
  let sql: ReturnType<typeof postgres>;
  /**
   * One connection per racer, not two `begin`s on a shared pool.
   *
   * Measured 2026-09-05 against Neon: with both transactions started on a single postgres.js
   * instance at `max: 4`, the second did not issue its SELECT until the first had COMMITTED —
   * editor B read version 4 where the whole point is that it reads 3. The two publishes were
   * therefore SEQUENTIAL, both won legitimately, and the suite reported that as the lost update
   * it was written to catch. It was reporting a P0 against a service whose compare-and-set is
   * correct: on genuinely separate connections the same statements yield one winner and one
   * zero-row UPDATE, exactly as `workflows-crud.service.ts:238` intends.
   *
   * A concurrency test that cannot be shown to have achieved concurrency proves nothing in
   * either direction, which is why `both editors read the same version` below is asserted
   * rather than assumed.
   */
  let racerA: ReturnType<typeof postgres>;
  let racerB: ReturnType<typeof postgres>;
  const orgId = `wf-cas-${randomUUID().slice(0, 12)}`;
  const userId = `wf-cas-user-${randomUUID().slice(0, 12)}`;
  let workflowId = "";

  beforeAll(async () => {
    sql = connect();
    racerA = connect();
    racerB = connect();
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
    if (racerA) await racerA.end({ timeout: 5 });
    if (racerB) await racerB.end({ timeout: 5 });
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
  async function publish(
    conn: ReturnType<typeof postgres>,
    definition: string,
    barrier: Promise<void>,
  ): Promise<PublishOutcome> {
    return conn.begin(async (tx) => {
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
      if (updated.length === 0) return { won: false, version: null, readVersion: expected };

      await tx`
        INSERT INTO workflow_versions (org_id, workflow_id, version, definition_json)
        VALUES (${orgId}, ${workflowId}::uuid, ${expected + 1}, ${sql.json({ d: definition })})
      `;
      return { won: true, version: expected + 1, readVersion: expected };
    });
  }

  let raceA: PublishOutcome;
  let raceB: PublishOutcome;

  beforeAll(async () => {
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const both = Promise.all([
      publish(racerA, "editor-a", barrier),
      publish(racerB, "editor-b", barrier),
    ]);
    // Both transactions park after their read. Letting them go together is what makes this a
    // race; the assertion below is what proves they actually parked rather than queued.
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    [raceA, raceB] = await both;
  });

  it("both editors read the same version, so the two publishes genuinely raced", () => {
    // Without this the suite cannot tell a lost update from two sequential publishes. When the
    // racers shared one connection the second read 4 where the first read 3, both won, and the
    // failure was reported against the service instead of against this harness.
    expect(raceA.readVersion).toBe(3);
    expect(raceB.readVersion).toBe(3);
  });

  it("exactly one of two simultaneous publishes wins; the other is refused", () => {
    expect([raceA.won, raceB.won].filter(Boolean)).toHaveLength(1);
    expect([raceA.won, raceB.won].filter((won) => !won)).toHaveLength(1);
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

    // One connection each, for the same reason the guarded race above needs them: two `begin`s
    // on one pool run in series, and in series the id-only form ALSO produces two winners —
    // passing this test for the opposite of the reason it was written.
    const headForm = async (
      conn: ReturnType<typeof postgres>,
    ): Promise<{ won: boolean; readVersion: number }> =>
      conn.begin(async (tx) => {
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
        return { won: updated.length > 0, readVersion: expected };
      });

    const both = Promise.all([headForm(racerA), headForm(racerB)]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    const [a, b] = await both;

    // The stale read is the defect. Without it the two writes are merely sequential and the
    // "both won" below says nothing about the predicate.
    expect(a.readVersion).toBe(3);
    expect(b.readVersion).toBe(3);
    expect(a.won).toBe(true);
    expect(b.won).toBe(true);
    const [row] = await sql`SELECT version FROM workflows WHERE id = ${biteId}::uuid`;
    // Two publishes, one version bump: the second read a stale 3 and wrote 4 on
    // top of the first's 4. That is the update that was lost.
    expect(Number(row?.["version"])).toBe(4);
  });
});
