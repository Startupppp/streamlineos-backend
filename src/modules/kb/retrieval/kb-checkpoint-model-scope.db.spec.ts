/**
 * A resumption checkpoint belongs to the model that produced its vector.
 *
 * `kb_ingestion_checkpoints` has no `embedding_model` column — verified against the live
 * catalog, its columns are (id, org_id, content_type, content_id, content_hash, chunk_index,
 * content, embedding, created_at) — and its natural key is
 * `(org_id, content_type, content_id, chunk_index)`. `loadCheckpoints` matched on
 * `(org_id, content_type, content_id, content_hash)` alone, so an ingestion interrupted
 * before a model upgrade left checkpoints in the OLD vector space; the retry after the
 * upgrade hit on `content_hash` — the text had not changed — reused those vectors, and
 * `replacePageBodyChunks` stamped them with the *current* `EMBEDDING_MODEL`. Cosine distance
 * across two embedding spaces is noise, and because `uniq_kb_chunks_page_revision` includes
 * `embedding_model` the database considers the result well-formed.
 *
 * The fix folds the model into the hash the store writes, so no schema change is needed:
 * a checkpoint written by one model cannot be found by another. This spec proves that
 * against a real Postgres, because the claim is about what a real row lookup returns.
 *
 *   APP_DATABASE_URL="postgresql://streamline_app:…@localhost:5432/scratch_head_1010" \
 *   DATABASE_URL="postgresql://tarunchintakunta@localhost:5432/scratch_head_1010" \
 *   PGSSLMODE=disable KB_DB_TESTS=1 \
 *   npx jest --runInBand --testPathPattern="kb-checkpoint-model-scope.db"
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import { createTenantAwareDb } from "../../../common/tenant/tenant-db";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";
import { KbIngestionCheckpointService } from "./kb-ingestion-checkpoint.service";

const ENABLED = process.env.KB_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const ORG = `kbckpt-${suffix}`;
const PROBE_USER = `kbckpt-user-${suffix}`;
const CONTENT_ID = 987_654;
const CONTENT_HASH = "a".repeat(64);
const DIM = 1536;

/** A vector that is unmistakably from one space or the other. */
function vector(seed: number): number[] {
  return Array.from({ length: DIM }, (_, i) => Math.sin((i + 1) * seed) );
}

describeDb("KB ingestion checkpoints are scoped to the embedding model", () => {
  let owner: ReturnType<typeof postgres>;
  let appClient: ReturnType<typeof postgres>;
  let appDb: ReturnType<typeof createTenantAwareDb>;
  let base: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL;
    const appUrl = process.env.APP_DATABASE_URL;
    if (!ownerUrl || !appUrl)
      throw new Error("KB_DB_TESTS needs DATABASE_URL (owner, seeds) and APP_DATABASE_URL (RLS role)");

    owner = postgres(ownerUrl, { prepare: false, max: 2, connect_timeout: 30 });
    appClient = postgres(appUrl, { prepare: false, max: 2, connect_timeout: 30 });
    base = drizzle(appClient, { schema });
    appDb = createTenantAwareDb(Object.assign(base, { __client: appClient }));

    // organizations ⇄ organization_members is circular and DEFERRABLE, so both go in
    // inside one transaction with the owner pointer corrected before commit.
    await owner.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`INSERT INTO users (id, email, name) VALUES (${PROBE_USER}, ${`${PROBE_USER}@kb-ckpt.invalid`}, 'KB checkpoint probe')`;
      await tx`INSERT INTO organizations (id, name, slug, owner_membership_id) VALUES (${ORG}, 'KB checkpoint probe', ${ORG}, 0)`;
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

  /**
   * `KbIngestionCheckpointService` reads `EMBEDDING_MODEL` at module scope, so a second
   * model means a second module registry. `isolateModules` gives one, and the doMock names
   * the model the isolated copy will fold into its stored hash.
   */
  async function serviceForModel(model: string): Promise<KbIngestionCheckpointService> {
    let built: KbIngestionCheckpointService | undefined;
    await jest.isolateModulesAsync(async () => {
      jest.doMock("../../ai/core/providers/embeddings.service", () => ({ EMBEDDING_MODEL: model }));
      const mod: typeof import("./kb-ingestion-checkpoint.service") = await import(
        "./kb-ingestion-checkpoint.service"
      );
      built = new mod.KbIngestionCheckpointService(appDb);
    });
    if (!built) throw new Error("isolateModulesAsync did not construct the service");
    return built;
  }

  /** Runs `fn` with the tenant GUC set, the way a request or a sweep does. */
  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    return base.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.organization_id', ${ORG}, true)`);
      return runWithTenantContext({ orgId: ORG, audience: "INTERNAL", tx }, fn);
    });
  }

  afterEach(async () => {
    await owner`DELETE FROM kb_ingestion_checkpoints WHERE org_id = ${ORG}`;
  });

  it("a checkpoint written under one model is not returned to another, so the text is re-embedded", async () => {
    const small = await serviceForModel("text-embedding-3-small");
    const large = await serviceForModel("text-embedding-3-large");

    await inTenant(() =>
      small.saveCheckpoints(ORG, "page", CONTENT_ID, CONTENT_HASH, [
        { chunkIndex: 0, content: "chunk zero", embedding: vector(0.7) },
        { chunkIndex: 1, content: "chunk one", embedding: vector(1.3) },
      ]),
    );

    const sameModel = await inTenant(() => small.loadCheckpoints(ORG, "page", CONTENT_ID, CONTENT_HASH));
    expect(sameModel.size).toBe(2);

    // The text did not change, so the caller passes the same content hash. Under the old
    // predicate this returned both old-space vectors; it must now return nothing.
    const afterUpgrade = await inTenant(() => large.loadCheckpoints(ORG, "page", CONTENT_ID, CONTENT_HASH));
    expect(afterUpgrade.size).toBe(0);
  }, 120_000);

  it("re-checkpointing under the new model replaces the row rather than leaving two", async () => {
    const small = await serviceForModel("text-embedding-3-small");
    const large = await serviceForModel("text-embedding-3-large");

    await inTenant(() =>
      small.saveCheckpoints(ORG, "page", CONTENT_ID, CONTENT_HASH, [
        { chunkIndex: 0, content: "chunk zero", embedding: vector(0.7) },
      ]),
    );
    await inTenant(() =>
      large.saveCheckpoints(ORG, "page", CONTENT_ID, CONTENT_HASH, [
        { chunkIndex: 0, content: "chunk zero", embedding: vector(2.9) },
      ]),
    );

    const [row] = await owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kb_ingestion_checkpoints
      WHERE org_id = ${ORG} AND content_type = 'page' AND content_id = ${CONTENT_ID}`;
    expect(row?.n).toBe(1);

    // The new model finds its own vector; the old model no longer finds anything.
    const newSpace = await inTenant(() => large.loadCheckpoints(ORG, "page", CONTENT_ID, CONTENT_HASH));
    expect(newSpace.size).toBe(1);
    const oldSpace = await inTenant(() => small.loadCheckpoints(ORG, "page", CONTENT_ID, CONTENT_HASH));
    expect(oldSpace.size).toBe(0);
  }, 120_000);

  /**
   * The witness for the defect itself, at the exact predicate HEAD used. HEAD stored the
   * caller's `sha256(text)` verbatim and looked it up with
   * `(org_id, content_type, content_id, content_hash)`, so this query IS the old
   * `loadCheckpoints`. Run against a row the OLD model wrote, it still matches — which is
   * the reuse of an old-vector-space embedding under a new model's name.
   */
  it("the pre-fix predicate would still have matched after a model change", async () => {
    await owner`
      INSERT INTO kb_ingestion_checkpoints (org_id, content_type, content_id, content_hash, chunk_index, content, embedding)
      VALUES (${ORG}, 'page', ${CONTENT_ID}, ${CONTENT_HASH}, 0, 'chunk zero', ${`[${vector(0.7).join(",")}]`})`;

    const legacyHit = await owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kb_ingestion_checkpoints
      WHERE org_id = ${ORG} AND content_type = 'page'
        AND content_id = ${CONTENT_ID} AND content_hash = ${CONTENT_HASH}`;
    expect(legacyHit[0]?.n).toBe(1);

    // The same row, asked for by the shipped service under either model: no hit, because
    // the model is folded into the hash it looks up.
    const small = await serviceForModel("text-embedding-3-small");
    const large = await serviceForModel("text-embedding-3-large");
    expect((await inTenant(() => small.loadCheckpoints(ORG, "page", CONTENT_ID, CONTENT_HASH))).size).toBe(0);
    expect((await inTenant(() => large.loadCheckpoints(ORG, "page", CONTENT_ID, CONTENT_HASH))).size).toBe(0);
  }, 120_000);

  it("the stored content_hash is not the caller's hash, which is why no schema column is needed", async () => {
    const small = await serviceForModel("text-embedding-3-small");
    await inTenant(() =>
      small.saveCheckpoints(ORG, "page", CONTENT_ID, CONTENT_HASH, [
        { chunkIndex: 0, content: "chunk zero", embedding: vector(0.7) },
      ]),
    );
    const [row] = await owner<{ content_hash: string }[]>`
      SELECT content_hash FROM kb_ingestion_checkpoints
      WHERE org_id = ${ORG} AND content_type = 'page' AND content_id = ${CONTENT_ID}`;
    expect(row?.content_hash).toHaveLength(64);
    expect(row?.content_hash).not.toBe(CONTENT_HASH);
  }, 120_000);
});
