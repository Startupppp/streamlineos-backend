import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import { KbPageTreeService } from "./kb-page-tree.service";
import { loadPageChunkState } from "../../retrieval/kb-chunk-repository";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const suffix = randomUUID().slice(0, 8);
const ORG = `kbrt-${suffix}`;
const USER = `kbrt-user-${suffix}`;

describe("KbPageTreeService restore against real Postgres — a restore that returns the row but not the tree link or the chunk state is a half-restore", () => {
  let owner: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let service: KbPageTreeService;
  let membershipId = 0;

  const commitManyPageChanges = jest.fn().mockResolvedValue(undefined);

  function actor(): CurrentUserContext {
    return {
      userId: USER,
      orgId: ORG,
      isOrgOwner: true,
      role: "owner",
      sessionId: `sess-${suffix}`,
      tokenScopes: null,
      principal: humanSessionPrincipal(membershipId, true),
    } as CurrentUserContext;
  }

  async function seedPage(title: string, parent: number | null): Promise<number> {
    const [row] = await owner<{ id: number }[]>`
      INSERT INTO kb_pages (org_id, title, visibility, status, content_text, created_by_id, created_by_membership_id, parent_page_id)
      VALUES (${ORG}, ${title}, 'org', 'published', ${`body of ${title}`}, ${USER}, ${membershipId}, ${parent})
      RETURNING id`;
    if (!row) throw new Error(`seed: page insert failed for ${title}`);
    return row.id;
  }

  async function readPage(id: number): Promise<{ deleted: boolean; parent: number | null }> {
    const [row] = await owner<{ deleted_at: Date | null; parent_page_id: number | null }[]>`
      SELECT deleted_at, parent_page_id FROM kb_pages WHERE id = ${id}`;
    if (!row) throw new Error(`page ${id} vanished`);
    return { deleted: row.deleted_at !== null, parent: row.parent_page_id };
  }

  async function seedChunk(pageId: number): Promise<void> {
    await owner`
      INSERT INTO kb_article_chunks (org_id, page_id, source, chunk_index, content, embedding, embedding_model, content_hash, acl_revision)
      VALUES (${ORG}, ${pageId}, 'page_body', 0, 'chunk text', array_fill(0::real, ARRAY[1536])::vector, 'test-model', 'hash-of-source-text', 1)`;
  }

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL;
    if (!ownerUrl) throw new Error("kb-page-restore-tree.db.spec.ts requires DATABASE_URL");
    owner = postgres(ownerUrl, { prepare: false, max: 2, connect_timeout: 30 });
    db = drizzle(owner, { schema });

    await owner.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`INSERT INTO users (id, email, name) VALUES (${USER}, ${`${USER}@kbrt.invalid`}, 'Restore Tree Seed')`;
      await tx`INSERT INTO organizations (id, name, slug, owner_membership_id) VALUES (${ORG}, ${ORG}, ${ORG}, 0)`;
      const [member] = await tx<{ id: number }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${USER}, ${ORG}, 'OWNER', true) RETURNING id`;
      if (!member) throw new Error("seed: membership insert failed");
      membershipId = member.id;
      await tx`UPDATE organizations SET owner_membership_id = ${member.id} WHERE id = ${ORG}`;
    });

    service = new KbPageTreeService(
      db as never,
      { log: jest.fn(), logCritical: jest.fn().mockResolvedValue(undefined) } as never,
      {
        visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
        assertPageAccess: jest.fn().mockResolvedValue(undefined),
      } as never,
      {} as never,
      { commitManyPageChanges, commitPageChange: jest.fn() } as never,
    );
  }, 120_000);

  afterAll(async () => {
    if (owner) {
      await owner`DELETE FROM kb_article_chunks WHERE org_id = ${ORG}`;
      await owner`UPDATE kb_pages SET parent_page_id = NULL WHERE org_id = ${ORG}`;
      await owner`DELETE FROM kb_pages WHERE org_id = ${ORG}`;
      await owner.begin(async (tx) => {
        await tx`SELECT set_config('app.audit_log_detachment', 'true', true)`;
        await tx`UPDATE audit_logs SET org_id = null, actor_membership_id = null, is_platform_event = true WHERE org_id = ${ORG}`;
        await tx`DELETE FROM organizations WHERE id = ${ORG}`;
      });
      await owner`DELETE FROM users WHERE id = ${USER} AND NOT EXISTS (SELECT 1 FROM audit_logs WHERE user_id = ${USER})`;
      await owner.end({ timeout: 5 });
    }
  }, 120_000);

  beforeEach(() => commitManyPageChanges.mockClear());

  it("clears deleted_at for every descendant the delete took, so the subtree comes back whole rather than as a root with orphaned children still in the trash", async () => {
    const root = await seedPage("whole subtree root", null);
    const child = await seedPage("whole subtree child", root);
    const grandchild = await seedPage("whole subtree grandchild", child);

    await service.softDelete(actor(), root);
    expect((await readPage(grandchild)).deleted).toBe(true);

    await service.restore(actor(), root);

    expect((await readPage(root)).deleted).toBe(false);
    expect((await readPage(child)).deleted).toBe(false);
    expect((await readPage(grandchild)).deleted).toBe(false);
  }, 60_000);

  it("re-parents a restored page to the root when its own parent is still in the trash, because a live child hanging off a deleted parent is invisible in a tree the trash filters", async () => {
    const parent = await seedPage("still trashed parent", null);
    const child = await seedPage("child restored alone", parent);

    await service.softDelete(actor(), parent);
    await service.restore(actor(), child);

    expect((await readPage(child)).deleted).toBe(false);
    expect((await readPage(child)).parent).toBeNull();
    expect((await readPage(parent)).deleted).toBe(true);
  }, 60_000);

  it("keeps the original parent link when that parent is live, so the re-parenting above is the trashed-parent branch and not an unconditional flattening", async () => {
    const parent = await seedPage("live parent", null);
    const child = await seedPage("child under live parent", parent);

    await service.softDelete(actor(), child);
    await service.restore(actor(), child);

    expect((await readPage(child)).deleted).toBe(false);
    expect((await readPage(child)).parent).toBe(parent);
  }, 60_000);

  it("refuses the second restore of the same page with a ConflictException and leaves the row exactly as the first restore left it, which is what makes the bulk path able to report it as succeeded", async () => {
    const parent = await seedPage("twice restored parent", null);
    const page = await seedPage("twice restored", parent);

    await service.softDelete(actor(), page);
    await service.restore(actor(), page);
    const afterFirst = await readPage(page);

    await expect(service.restore(actor(), page)).rejects.toBeInstanceOf(ConflictException);

    expect(await readPage(page)).toEqual(afterFirst);
  }, 60_000);

  it("emits no second index event on the refused restore, so replaying a restore cannot double the re-embedding cost", async () => {
    const page = await seedPage("index once", null);

    await service.softDelete(actor(), page);
    await service.restore(actor(), page);
    expect(commitManyPageChanges).toHaveBeenCalledTimes(1);

    await expect(service.restore(actor(), page)).rejects.toBeInstanceOf(ConflictException);

    expect(commitManyPageChanges).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("leaves no stored chunk state behind after the delete, so the re-index the restore asks for rebuilds the vectors instead of short-circuiting on an unchanged content hash", async () => {
    const page = await seedPage("chunked page", null);
    await seedChunk(page);
    expect(await loadPageChunkState(db as never, ORG, page)).not.toBeNull();

    await service.softDelete(actor(), page);

    expect(await loadPageChunkState(db as never, ORG, page)).toBeNull();
  }, 60_000);

  it("asks for a re-index of the restored page, which is the only thing that puts the deleted chunks back", async () => {
    const page = await seedPage("reindexed page", null);
    await seedChunk(page);

    await service.softDelete(actor(), page);
    await service.restore(actor(), page);

    expect(commitManyPageChanges).toHaveBeenCalledTimes(1);
    const [, input] = commitManyPageChanges.mock.calls[0] as [
      unknown,
      { orgId: string; pages: ReadonlyArray<{ id: number; contentText: string | null }> },
    ];
    expect(input.orgId).toBe(ORG);
    expect(input.pages.map((p) => p.id)).toContain(page);
  }, 60_000);
});
