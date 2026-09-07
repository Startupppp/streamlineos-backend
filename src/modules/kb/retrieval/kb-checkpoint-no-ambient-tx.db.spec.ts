/**
 * `loadCheckpoints` is entered with NO ambient tenant context, and has to survive it.
 *
 * Both reindex routes carry `@NoTenantTransaction()` so an embedding round trip cannot pin
 * a pooled connection against `withTenant`'s 60s `idle_in_transaction_session_timeout`.
 * That decorator means the `DRIZZLE` proxy has no ambient transaction to borrow and falls
 * through to the pool, which carries no tenant GUC — and `kb_ingestion_checkpoints` is
 * RLS-enabled under `org_id = current_org_id()`, the variant that RAISES 42501 rather than
 * returning NULL. `saveCheckpoints` already opened its own transaction; the read did not,
 * so `POST /kb/pages/:pageId/reindex` and `POST /kb/pages/reindex-all` both died on the
 * FIRST statement `indexPage` issues after resolving the page. No reindex was requestable.
 *
 * This is the same class of defect `kb-page-reindex-placement.db.spec.ts` pins for the
 * reindex-all LISTING, on the other statement the decorator exposed. Both halves are
 * measured rather than reasoned, because which policy variant a table carries — raising or
 * `_or_null` — decides whether the mistake fails loudly or silently, and that differs per
 * table.
 *
 *   APP_DATABASE_URL="postgresql://streamline_app@localhost:5432/scratch_head_1010" \
 *   DATABASE_URL="postgresql://neondb_owner@localhost:5432/scratch_head_1010" \
 *   PGSSLMODE=disable \
 *   pnpm test:db-specs --testPathPattern="kb-checkpoint-no-ambient-tx.db"
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import { createTenantAwareDb } from "../../../common/tenant/tenant-db";
import { getTenantContext, runWithTenantContext } from "../../../common/tenant/tenant-context";
import { KbIngestionCheckpointService } from "./kb-ingestion-checkpoint.service";

const suffix = randomUUID().slice(0, 8);
const ORG = `kbnoctx-${suffix}`;
const PROBE_USER = `kbnoctx-user-${suffix}`;
const CONTENT_ID = 424_242;
const CONTENT_HASH = "b".repeat(64);
const DIM = 1536;

const vector = (): number[] => Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));

describe("KB ingestion checkpoints are readable with no ambient tenant context", () => {
  let owner: ReturnType<typeof postgres>;
  let appClient: ReturnType<typeof postgres>;
  let base: ReturnType<typeof drizzle<typeof schema>>;
  let checkpoints: KbIngestionCheckpointService;

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL;
    const appUrl = process.env.APP_DATABASE_URL;
    if (!ownerUrl || !appUrl)
      throw new Error("kb-checkpoint-no-ambient-tx.db.spec.ts requires DATABASE_URL (owner) and APP_DATABASE_URL (RLS role)");

    owner = postgres(ownerUrl, { prepare: false, max: 2, connect_timeout: 30 });
    appClient = postgres(appUrl, { prepare: false, max: 2, connect_timeout: 30 });
    base = drizzle(appClient, { schema });
    checkpoints = new KbIngestionCheckpointService(
      createTenantAwareDb(Object.assign(base, { __client: appClient })),
    );

    await owner.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`INSERT INTO users (id, email, name) VALUES (${PROBE_USER}, ${`${PROBE_USER}@kb-noctx.invalid`}, 'KB no-context probe')`;
      await tx`INSERT INTO organizations (id, name, slug, owner_membership_id) VALUES (${ORG}, 'KB no-context probe', ${ORG}, 0)`;
      const [member] = await tx<{ id: number }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${PROBE_USER}, ${ORG}, 'OWNER', true) RETURNING id`;
      await tx`UPDATE organizations SET owner_membership_id = ${member?.id} WHERE id = ${ORG}`;
    });
  }, 180_000);

  afterAll(async () => {
    if (owner) {
      await owner`DELETE FROM kb_ingestion_checkpoints WHERE org_id = ${ORG}`;
      await owner`DELETE FROM organizations WHERE id = ${ORG}`;
      await owner`DELETE FROM users WHERE id = ${PROBE_USER}`;
      await owner.end({ timeout: 5 });
    }
    if (appClient) await appClient.end({ timeout: 5 });
  }, 60_000);

  it(
    "reads back a saved checkpoint from outside any tenant transaction, the state a @NoTenantTransaction route is in",
    async () => {
      // The precondition, asserted rather than assumed: if something upstream leaves an
      // ambient context behind, the proxy borrows it and this test proves nothing.
      expect(getTenantContext()).toBeUndefined();

      await checkpoints.saveCheckpoints(ORG, "page", CONTENT_ID, CONTENT_HASH, [
        { chunkIndex: 0, content: "chunk zero", embedding: vector() },
        { chunkIndex: 1, content: "chunk one", embedding: vector() },
      ]);

      const loaded = await checkpoints.loadCheckpoints(ORG, "page", CONTENT_ID, CONTENT_HASH);
      expect(loaded.size).toBe(2);
    },
    120_000,
  );

  it(
    "still reuses an ambient transaction when the caller has one, rather than opening a second",
    async () => {
      await base.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.organization_id', ${ORG}, true)`);
        await runWithTenantContext({ orgId: ORG, audience: "INTERNAL", tx }, async () => {
          const loaded = await checkpoints.loadCheckpoints(ORG, "page", CONTENT_ID, CONTENT_HASH);
          expect(loaded.size).toBe(2);
        });
      });
    },
    120_000,
  );

  it(
    "refuses an orgId that disagrees with the ambient context rather than reading across tenants",
    async () => {
      await base.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.organization_id', ${ORG}, true)`);
        await runWithTenantContext({ orgId: ORG, audience: "INTERNAL", tx }, async () => {
          await expect(
            checkpoints.loadCheckpoints(`${ORG}-other`, "page", CONTENT_ID, CONTENT_HASH),
          ).rejects.toThrow(/refusing to open a transaction for org/);
        });
      });
    },
    120_000,
  );
});
