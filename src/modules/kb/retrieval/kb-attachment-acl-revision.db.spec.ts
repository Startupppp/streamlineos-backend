import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import { createTenantAwareDb } from "../../../common/tenant/tenant-db";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";
import { KbCandidateService } from "./kb-candidate.service";
import {
  attachmentChunks,
  loadDerivedChunkState,
  replaceAttachmentChunks,
  updateDerivedChunkAcl,
} from "./kb-derived-chunk-state";

const suffix = randomUUID().slice(0, 8);
const ORG = `kbacl-${suffix}`;
const PROBE_USER = `kbacl-user-${suffix}`;
/** The page's revision. Anything above the chunk column default of 1 exposes the defect. */
const ARTICLE_ACL_REVISION = 5;
const DIM = 1536;
const CONTENT_HASH = "b".repeat(64);
const PRINCIPAL = { userId: PROBE_USER, membershipId: null, roleSlugs: [] };

function embedding(seed: number): number[] {
  return Array.from({ length: DIM }, (_, i) => Math.sin((i + 1) * seed));
}

describe("KB attachment chunks carry the parent page's ACL revision", () => {
  let owner: ReturnType<typeof postgres>;
  let appClient: ReturnType<typeof postgres>;
  let appDb: ReturnType<typeof createTenantAwareDb>;
  let base: ReturnType<typeof drizzle<typeof schema>>;
  let candidates: KbCandidateService;
  let spaceId: number;
  let articleId: number;
  let attachmentId: number;
  let queryVector: string;

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL;
    const appUrl = process.env.APP_DATABASE_URL;
    if (!ownerUrl || !appUrl)
      throw new Error(
        "kb-attachment-acl-revision.db.spec.ts requires DATABASE_URL (owner) and APP_DATABASE_URL (RLS role)",
      );

    owner = postgres(ownerUrl, { prepare: false, max: 2, connect_timeout: 30 });
    appClient = postgres(appUrl, {
      prepare: false,
      max: 2,
      connect_timeout: 30,
    });
    base = drizzle(appClient, { schema });
    appDb = createTenantAwareDb(Object.assign(base, { __client: appClient }));
    candidates = new KbCandidateService(appDb);

    await owner.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`INSERT INTO users (id, email, name) VALUES (${PROBE_USER}, ${`${PROBE_USER}@kb-acl.invalid`}, 'KB ACL probe')`;
      await tx`INSERT INTO organizations (id, name, slug, owner_membership_id) VALUES (${ORG}, 'KB ACL probe', ${ORG}, 0)`;
      const [member] = await tx<{ id: number }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${PROBE_USER}, ${ORG}, 'OWNER', true) RETURNING id`;
      await tx`UPDATE organizations SET owner_membership_id = ${member?.id} WHERE id = ${ORG}`;
    });

    const [space] = await owner<{ id: number }[]>`
      INSERT INTO kb_spaces (org_id, name, slug) VALUES (${ORG}, 'ACL probe space', ${`acl-${suffix}`}) RETURNING id`;
    spaceId = space?.id ?? 0;

    // The article sits above revision 1 — the state a space membership change leaves behind.
    const [article] = await owner<{ id: number }[]>`
      INSERT INTO kb_pages (org_id, space_id, title, slug, content_text, status, content_type, acl_revision)
      VALUES (${ORG}, ${spaceId}, 'Employee handbook', ${`handbook-${suffix}`}, 'body', 'published', 'support_article', ${ARTICLE_ACL_REVISION})
      RETURNING id`;
    articleId = article?.id ?? 0;

    const [attachment] = await owner<{ id: number }[]>`
      INSERT INTO kb_page_attachments (org_id, page_id, file_name, file_key, mime_type, file_size)
      VALUES (${ORG}, ${articleId}, 'handbook.pdf', ${`kb/${suffix}/handbook.pdf`}, 'application/pdf', 1024)
      RETURNING id`;
    attachmentId = attachment?.id ?? 0;

    queryVector = `[${embedding(0.7).join(",")}]`;
  }, 180_000);

  afterAll(async () => {
    if (owner) {
      await owner`DELETE FROM kb_article_chunks WHERE org_id = ${ORG}`;
      await owner`DELETE FROM organizations WHERE id = ${ORG}`;
      await owner`DELETE FROM users WHERE id = ${PROBE_USER}`;
      await owner.end({ timeout: 5 });
    }
    if (appClient) await appClient.end({ timeout: 5 });
  }, 60_000);

  afterEach(async () => {
    await owner`DELETE FROM kb_article_chunks WHERE org_id = ${ORG}`;
  });

  /** One tenant transaction with the GUC set, the way the ingestion consumer runs. */
  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    return base.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.organization_id', ${ORG}, true)`,
      );
      return runWithTenantContext({ orgId: ORG, audience: "INTERNAL", tx }, fn);
    });
  }

  /** The insert `indexAttachment` used to issue: every column except `acl_revision`. */
  async function insertLegacyAttachmentChunk(): Promise<void> {
    await owner`
      INSERT INTO kb_article_chunks (org_id, page_id, attachment_id, source, chunk_index, content, embedding, embedding_model)
      VALUES (${ORG}, ${articleId}, ${attachmentId}, 'attachment', 0, 'handbook chunk', ${queryVector}, 'text-embedding-3-small')`;
  }

  it("the pre-fix insert leaves the chunk at the column default, one the candidate join cannot match", async () => {
    await insertLegacyAttachmentChunk();

    const [row] = await owner<{ acl_revision: number }[]>`
      SELECT acl_revision FROM kb_article_chunks WHERE org_id = ${ORG} AND attachment_id = ${attachmentId}`;
    expect(row?.acl_revision).toBe(1);
    expect(row?.acl_revision).not.toBe(ARTICLE_ACL_REVISION);

    const found = await inTenant(() =>
      candidates.articleVectorCandidates(
        ORG,
        [spaceId],
        queryVector,
        10,
        PRINCIPAL,
        null,
      ),
    );
    expect(found).toEqual([]);
  }, 120_000);

  it("the shipped writer carries the article's revision, and the article is retrievable", async () => {
    await inTenant(() =>
      replaceAttachmentChunks(
        appDb,
        ORG,
        attachmentId,
        null,
        ["handbook chunk"],
        [embedding(0.7)],
        {
          contentHash: CONTENT_HASH,
          aclRevision: ARTICLE_ACL_REVISION,
        },
      ),
    );

    const [row] = await owner<{ acl_revision: number; content_hash: string }[]>`
      SELECT acl_revision, content_hash FROM kb_article_chunks WHERE org_id = ${ORG} AND attachment_id = ${attachmentId}`;
    expect(row?.acl_revision).toBe(ARTICLE_ACL_REVISION);
    expect(row?.content_hash).toBe(CONTENT_HASH);

    const found = await inTenant(() =>
      candidates.articleVectorCandidates(
        ORG,
        [spaceId],
        queryVector,
        10,
        PRINCIPAL,
        null,
      ),
    );
    expect(found).toContain(articleId);
  }, 120_000);

  it("the stored state is what the skip-if-unchanged short-circuit reads", async () => {
    await inTenant(() =>
      replaceAttachmentChunks(
        appDb,
        ORG,
        attachmentId,
        null,
        ["a", "b", "c"],
        [embedding(0.7), embedding(1.1), embedding(1.9)],
        {
          contentHash: CONTENT_HASH,
          aclRevision: ARTICLE_ACL_REVISION,
        },
      ),
    );

    const state = await inTenant(() =>
      loadDerivedChunkState(appDb, attachmentChunks(ORG, attachmentId)),
    );
    expect(state).toEqual({
      contentHash: CONTENT_HASH,
      aclRevision: ARTICLE_ACL_REVISION,
      chunkCount: 3,
    });
  }, 120_000);

  it("an ACL-only change moves the revision without touching the vectors", async () => {
    await inTenant(() =>
      replaceAttachmentChunks(
        appDb,
        ORG,
        attachmentId,
        null,
        ["handbook chunk"],
        [embedding(0.7)],
        {
          contentHash: CONTENT_HASH,
          aclRevision: ARTICLE_ACL_REVISION,
        },
      ),
    );
    const [before] = await owner<{ embedding: string }[]>`
      SELECT embedding::text AS embedding FROM kb_article_chunks WHERE org_id = ${ORG} AND attachment_id = ${attachmentId}`;

    await owner`UPDATE kb_pages SET acl_revision = ${ARTICLE_ACL_REVISION + 1} WHERE org_id = ${ORG} AND id = ${articleId}`;
    await inTenant(() =>
      updateDerivedChunkAcl(
        appDb,
        attachmentChunks(ORG, attachmentId),
        ARTICLE_ACL_REVISION + 1,
      ),
    );

    const [after] = await owner<{ acl_revision: number; embedding: string }[]>`
      SELECT acl_revision, embedding::text AS embedding FROM kb_article_chunks WHERE org_id = ${ORG} AND attachment_id = ${attachmentId}`;
    expect(after?.acl_revision).toBe(ARTICLE_ACL_REVISION + 1);
    expect(after?.embedding).toBe(before?.embedding);

    const found = await inTenant(() =>
      candidates.articleVectorCandidates(
        ORG,
        [spaceId],
        queryVector,
        10,
        PRINCIPAL,
        null,
      ),
    );
    expect(found).toContain(articleId);

    await owner`UPDATE kb_pages SET acl_revision = ${ARTICLE_ACL_REVISION} WHERE org_id = ${ORG} AND id = ${articleId}`;
  }, 120_000);
});
