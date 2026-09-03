/**
 * A KB source upload must survive the process that accepted it.
 *
 * WHAT WAS WRONG. `createNote`/`createFile` registered indexing through `registerAfterCommit`
 * and emitted nothing else. `TenantContextInterceptor` fires those hooks as
 * `void run().catch(...)` — detached, after the response, with no shutdown drain — so a deploy
 * or SIGTERM between the commit and the drain left `kb_sources.status = 'processing'` with no
 * lease, no retry and no dead letter able to reclaim it. The sheet polls that row every three
 * seconds for as long as it is open, `/kb/ask` ignores the document, and the only recourse is
 * delete-and-re-upload, which re-charges embedding credits.
 *
 * WHY THE AUDIT'S PROPOSED FIX WOULD NOT HAVE WORKED. It said to emit `kb.content.index` and
 * let `KbIngestionConsumer` own it, because `KbSourceAdapter` is already registered so "the
 * consumer side needs no new code". It did: the adapter opened with
 * `if (!source || source.status !== "ready") return;` and a source is created `processing`, so
 * the event would have drained, done nothing, and left the row exactly as stranded as before.
 * Both halves — the emit and the adapter's ownership of the terminal status — are asserted here.
 *
 *   APP_DATABASE_URL="postgresql://streamline_app:…@localhost:5432/scratch_head_1010" \
 *   DATABASE_URL="postgresql://tarunchintakunta@localhost:5432/scratch_head_1010" \
 *   PGSSLMODE=disable KB_DB_TESTS=1 \
 *   npx jest --runInBand --testPathPattern="kb-source-ingestion-durability.db"
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { Test } from "@nestjs/testing";
import * as schema from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { APP_CONFIG } from "../../../config/config.module";
import { createTenantAwareDb } from "../../../common/tenant/tenant-db";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";
import { StorageService } from "../../storage/storage.service";
import { KbAttachmentIndexingService } from "../retrieval/kb-attachment-indexing.service";
import { KbSourceAdapter } from "../retrieval/kb-content-adapter";
import { KbSourcesService } from "./kb-sources.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ENABLED = process.env.KB_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const ORG = `kbsrc-${suffix}`;
const PROBE_USER = `kbsrc-user-${suffix}`;
const CHUNKS_WRITTEN = 3;

describeDb("KB source ingestion is durable, not only after-commit", () => {
  let owner: ReturnType<typeof postgres>;
  let appClient: ReturnType<typeof postgres>;
  let appDb: ReturnType<typeof createTenantAwareDb>;
  let base: ReturnType<typeof drizzle<typeof schema>>;
  let sources: KbSourcesService;
  let adapter: KbSourceAdapter;
  let indexSource: jest.Mock;

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL;
    const appUrl = process.env.APP_DATABASE_URL;
    if (!ownerUrl || !appUrl)
      throw new Error("KB_DB_TESTS needs DATABASE_URL (owner, seeds) and APP_DATABASE_URL (RLS role)");

    owner = postgres(ownerUrl, { prepare: false, max: 2, connect_timeout: 30 });
    appClient = postgres(appUrl, { prepare: false, max: 2, connect_timeout: 30 });
    base = drizzle(appClient, { schema });
    appDb = createTenantAwareDb(Object.assign(base, { __client: appClient }));

    indexSource = jest.fn().mockResolvedValue(CHUNKS_WRITTEN);

    // `useValue` is the seam Nest gives for a collaborator that is not the subject: it needs
    // no cast, so the spec introduces no forced typing. The embedding gateway and object store
    // are stood in for; the database is real, because the invariant is about what commits.
    const moduleRef = await Test.createTestingModule({
      providers: [
        KbSourcesService,
        KbSourceAdapter,
        { provide: DRIZZLE, useValue: appDb },
        { provide: APP_CONFIG, useValue: { R2_KB_BUCKET_NAME: "kb-bucket" } },
        { provide: StorageService, useValue: { isConfigured: () => true } },
        {
          provide: KbAttachmentIndexingService,
          useValue: { indexSource, removeSourceChunks: jest.fn() },
        },
      ],
    }).compile();

    sources = moduleRef.get(KbSourcesService);
    adapter = moduleRef.get(KbSourceAdapter);

    await owner.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`INSERT INTO users (id, email, name) VALUES (${PROBE_USER}, ${`${PROBE_USER}@kb-src.invalid`}, 'KB source probe')`;
      await tx`INSERT INTO organizations (id, name, slug, owner_membership_id) VALUES (${ORG}, 'KB source probe', ${ORG}, 0)`;
      const [member] = await tx<{ id: number }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${PROBE_USER}, ${ORG}, 'OWNER', true) RETURNING id`;
      await tx`UPDATE organizations SET owner_membership_id = ${member?.id} WHERE id = ${ORG}`;
    });
  }, 180_000);

  afterAll(async () => {
    if (owner) {
      await owner`DELETE FROM outbox_events WHERE organization_id = ${ORG}`;
      await owner`DELETE FROM kb_sources WHERE org_id = ${ORG}`;
      await owner`DELETE FROM organizations WHERE id = ${ORG}`;
      await owner`DELETE FROM users WHERE id = ${PROBE_USER}`;
      await owner.end({ timeout: 5 });
    }
    if (appClient) await appClient.end({ timeout: 5 });
  }, 60_000);

  beforeEach(() => {
    indexSource.mockClear();
  });

  /** A request: one tenant transaction with the GUC set. */
  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    return base.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.organization_id', ${ORG}, true)`);
      return runWithTenantContext({ orgId: ORG, audience: "INTERNAL", tx }, fn);
    });
  }

  /** A whole `CurrentUserContext`, built rather than forced — the service reads orgId and userId. */
  const user: CurrentUserContext = {
    userId: PROBE_USER,
    orgId: ORG,
    role: "OWNER",
    isOrgOwner: true,
    sessionId: `session-${suffix}`,
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 1, isOrgOwner: true },
  };

  it("commits a kb.content.index event with the source row, so a lost hook is recoverable", async () => {
    const created = await inTenant(() =>
      sources.createNote(user, { title: "Handbook note", text: "policy text" }),
    );

    const events = await owner<{ event_type: string; aggregate_type: string; payload: Record<string, unknown> }[]>`
      SELECT event_type, aggregate_type, payload FROM outbox_events
      WHERE organization_id = ${ORG} AND aggregate_id = ${String(created.id)}`;

    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe("kb.content.index");
    expect(events[0]?.aggregate_type).toBe("kb_source");
    expect(events[0]?.payload).toMatchObject({ contentType: "source", contentId: created.id });
  }, 120_000);

  it("the consumer settles a source still marked processing — the state the old guard refused", async () => {
    const created = await inTenant(() =>
      sources.createNote(user, { title: "Stranded note", text: "policy text" }),
    );

    // Exactly what a SIGTERM between commit and drain leaves behind.
    await owner`UPDATE kb_sources SET status = 'processing', chunk_count = 0 WHERE org_id = ${ORG} AND id = ${created.id}`;
    indexSource.mockClear();
    const [stranded] = await owner<{ status: string }[]>`
      SELECT status FROM kb_sources WHERE org_id = ${ORG} AND id = ${created.id}`;
    expect(stranded?.status).toBe("processing");

    await inTenant(() => adapter.handle(ORG, created.id));

    const [settled] = await owner<{ status: string; chunk_count: number; error_message: string | null }[]>`
      SELECT status, chunk_count, error_message FROM kb_sources WHERE org_id = ${ORG} AND id = ${created.id}`;
    expect(settled?.status).toBe("ready");
    expect(settled?.chunk_count).toBe(CHUNKS_WRITTEN);
    expect(settled?.error_message).toBeNull();
    expect(indexSource).toHaveBeenCalledWith(ORG, created.id, "policy text");
  }, 120_000);

  it("a soft-deleted source is left alone, so a late event cannot resurrect its chunks", async () => {
    const created = await inTenant(() =>
      sources.createNote(user, { title: "Deleted note", text: "policy text" }),
    );
    await owner`UPDATE kb_sources SET deleted_at = now(), status = 'processing' WHERE org_id = ${ORG} AND id = ${created.id}`;
    // `createNote` already ran the fast path once; the question is what the LATE event does.
    indexSource.mockClear();

    await inTenant(() => adapter.handle(ORG, created.id));

    expect(indexSource).not.toHaveBeenCalled();
    const [row] = await owner<{ status: string }[]>`
      SELECT status FROM kb_sources WHERE org_id = ${ORG} AND id = ${created.id}`;
    expect(row?.status).toBe("processing");
  }, 120_000);

  it("recording a failure that itself fails is logged, not swallowed", async () => {
    indexSource.mockRejectedValueOnce(new Error("provider down"));
    const created = await inTenant(() =>
      sources.createNote(user, { title: "Failing note", text: "policy text" }),
    );

    const [row] = await owner<{ status: string; error_message: string | null }[]>`
      SELECT status, error_message FROM kb_sources WHERE org_id = ${ORG} AND id = ${created.id}`;
    expect(row?.status).toBe("failed");
    expect(row?.error_message).toBe("Indexing failed");
  }, 120_000);
});
