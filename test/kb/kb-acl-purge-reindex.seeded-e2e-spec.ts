import { and, eq, inArray, sql } from "drizzle-orm";
import {
  kbArticleChunks,
  kbArticles,
  kbPages,
  kbSources,
  kbSpaceMembers,
  kbSpaces,
} from "src/db/schema";
import { kbIngestionCheckpoints } from "src/db/schema/support/kb-ingestion-checkpoints";
import { KB_EMBEDDING_DIMENSIONS } from "src/db/schema/support/kb-chunks";
import { AiGatewayService } from "src/modules/ai/core/gateway/ai-gateway.service";
import { KbAskService } from "src/modules/kb/retrieval/kb-ask.service";
import { KbIndexingService } from "src/modules/kb/retrieval/kb-indexing.service";
import { chunkText, sha256 } from "src/modules/kb/retrieval/kb-chunk-utils";
import { KbMembersService } from "src/modules/kb/wiki/kb-members.service";
import { KbSourcesService } from "src/modules/kb/wiki/kb-sources.service";
import type { CurrentUserContext } from "src/common/auth/backend-claims";
import { humanSessionPrincipal } from "src/common/auth/principal";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededMember } from "test/helpers/seed-builder";

/**
 * The three lifecycle transitions PRD-C135 names — ACL revocation, purge and reindex —
 * end to end against a real PostgreSQL, because each one is a claim about what the
 * database contains AFTER a mutation and no unit test with a mocked `db` can make it.
 *
 * Only the two outbound provider calls are replaced (the embedding request and the
 * answer completion). Everything downstream of them is production code against
 * production SQL: the accessible-space computation and its cache invalidation, the
 * keyword and vector candidate predicates, the post-answer citation re-verification,
 * the chunk delete on purge, and the chunk-replacement transaction on reindex.
 */

const asMember = (member: SeededMember, orgId: string): CurrentUserContext => ({
  userId: member.userId,
  orgId,
  isOrgOwner: false,
  role: "MEMBER",
  sessionId: `seeded-${member.userId}`,
  tokenScopes: null,
  principal: humanSessionPrincipal(member.membershipId, false),
});

const unitVector = (): number[] =>
  Array.from({ length: KB_EMBEDDING_DIMENSIONS }, (_, index) => (index === 0 ? 1 : 0));

const okUsage = {
  model: "seeded-e2e-model",
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
  credits: 0,
  costUsd: 0,
};

describe("[seeded-e2e] KB ACL revocation, source purge and page reindex", () => {
  let seededApp: SeededE2eApp;

  beforeAll(async () => {
    seededApp = await createSeededE2eApp();
  }, 120_000);

  afterAll(async () => {
    await seededApp.close();
  });

  it(
    "stops citing a space's article the moment the asker is removed from that space",
    async () => {
      const fixture = await seedOrg(seededApp.seedDb)
        .addMember("insider")
        .addMember("keeper")
        .build();
      await fixture.grantPermissions("insider", ["kb:articles:view"]);
      await fixture.grantPermissions("keeper", ["kb:articles:view"]);

      const db = seededApp.seedDb;
      const ask = seededApp.app.get(KbAskService);
      const members = seededApp.app.get(KbMembersService);
      const gateway = seededApp.app.get(AiGatewayService);
      const insider = fixture.members["insider"];
      const keeper = fixture.members["keeper"];
      if (!insider || !keeper) throw new Error("seed: acl fixture members missing");

      /**
       * Keyword-only retrieval, deliberately. The vector path also joins on
       * `chunk.acl_revision = article.acl_revision`, which the removal bumps — so a
       * vector-backed assertion could pass on chunk staleness while the space
       * predicate itself was broken. With embeddings off, `inArray(kbArticles.spaceId,
       * accessibleSpaceIds)` is the only thing that can exclude the article.
       */
      const embeddingOff = jest.spyOn(gateway, "isEmbeddingConfigured").mockReturnValue(false);
      const invoke = jest
        .spyOn(gateway, "invokeTextWithUsage")
        .mockResolvedValue({ ok: true, data: "Seeded answer.", aiUsage: okUsage, correlationId: "kb-acl-spec" });

      try {
        const [space] = await db
          .insert(kbSpaces)
          .values({
            orgId: fixture.orgId,
            name: "Restricted policy space",
            slug: `restricted-${fixture.orgId.slice(0, 8)}`,
            audience: "internal",
          })
          .returning({ id: kbSpaces.id });
        if (!space) throw new Error("seed: space insert failed");

        /**
         * BOTH members are seeded into the space and only one is removed. A space with
         * no member rows left is treated as unrestricted by
         * `computeAccessibleSpaceIds`, so removing the only member would hand the
         * article straight back and the assertion below would be testing nothing.
         */
        const memberRows = await db
          .insert(kbSpaceMembers)
          .values([
            { orgId: fixture.orgId, spaceId: space.id, membershipId: insider.membershipId, spaceRole: "viewer" },
            { orgId: fixture.orgId, spaceId: space.id, membershipId: keeper.membershipId, spaceRole: "viewer" },
          ])
          .returning({ id: kbSpaceMembers.id, membershipId: kbSpaceMembers.membershipId });
        const insiderRow = memberRows.find((row) => row.membershipId === insider.membershipId);
        if (!insiderRow) throw new Error("seed: insider space membership missing");

        const [article] = await db
          .insert(kbArticles)
          .values({
            orgId: fixture.orgId,
            spaceId: space.id,
            title: "Sabbatical stipend policy",
            slug: `sabbatical-stipend-${fixture.orgId.slice(0, 8)}`,
            content: "Sabbatical stipend policy",
            contentText: "The sabbatical stipend policy pays a stipend during an approved sabbatical.",
            status: "published",
            authorId: insider.userId,
            ownerMembershipId: insider.membershipId,
          })
          .returning({ id: kbArticles.id, aclRevision: kbArticles.aclRevision });
        if (!article) throw new Error("seed: article insert failed");

        await db.insert(kbArticleChunks).values({
          orgId: fixture.orgId,
          articleId: article.id,
          source: "article_body",
          chunkIndex: 0,
          content: "The sabbatical stipend policy pays a stipend during an approved sabbatical.",
          embedding: unitVector(),
          embeddingModel: "seeded-acl-test",
          aclRevision: article.aclRevision,
        });

        const question = "sabbatical stipend policy";
        const before = await ask.ask(asMember(insider, fixture.orgId), { question });
        expect(before.citations).toContainEqual(
          expect.objectContaining({ kind: "article", articleId: article.id }),
        );

        /**
         * `DELETE /kb/spaces/:spaceId/members/:memberId` carries no
         * `@NoTenantTransaction()`, so it runs inside the request's tenant transaction and
         * `kb_space_members`' RLS policy is satisfied by that GUC. Reproduced here rather
         * than removed, so the failure surface is the service, not the harness.
         */
        await runInNewTenantTransaction(
          seededApp.app.get<Db>(DRIZZLE),
          fixture.orgId,
          () => members.remove(fixture.orgId, space.id, insiderRow.id),
        );

        const after = await ask.ask(asMember(insider, fixture.orgId), { question });
        expect(after.citations).toEqual([]);

        /**
         * The control. Without it a broken retrieval — an embedding outage, a wrong
         * `fts` query, an article the seed never committed — produces the same empty
         * citation list and reads as a passing ACL test.
         */
        const keeperAfter = await ask.ask(asMember(keeper, fixture.orgId), { question });
        expect(keeperAfter.citations).toContainEqual(
          expect.objectContaining({ kind: "article", articleId: article.id }),
        );
      } finally {
        embeddingOff.mockRestore();
        invoke.mockRestore();
        await fixture.teardown();
      }
    },
    180_000,
  );

  it(
    "deletes a purged source's chunks and stops citing it",
    async () => {
      const fixture = await seedOrg(seededApp.seedDb).addMember("reader").build();
      await fixture.grantPermissions("reader", ["kb:articles:view"]);

      const db = seededApp.seedDb;
      const ask = seededApp.app.get(KbAskService);
      const sources = seededApp.app.get(KbSourcesService);
      const gateway = seededApp.app.get(AiGatewayService);
      const reader = fixture.members["reader"];
      if (!reader) throw new Error("seed: purge fixture member missing");

      const vector = unitVector();
      const embeddingOn = jest.spyOn(gateway, "isEmbeddingConfigured").mockReturnValue(true);
      const embedQuery = jest
        .spyOn(gateway, "embedQueryWithCredit")
        .mockResolvedValue({ ok: true, vector, vectorLiteral: JSON.stringify(vector) });
      const invoke = jest
        .spyOn(gateway, "invokeTextWithUsage")
        .mockResolvedValue({ ok: true, data: "Seeded answer.", aiUsage: okUsage, correlationId: "kb-acl-spec" });

      try {
        const [source] = await db
          .insert(kbSources)
          .values({
            orgId: fixture.orgId,
            kind: "note",
            title: "Expense reimbursement note",
            noteText: "Expense reimbursement is settled within ten working days.",
            status: "ready",
            chunkCount: 1,
            createdById: reader.userId,
          })
          .returning({ id: kbSources.id });
        if (!source) throw new Error("seed: source insert failed");

        await db.insert(kbArticleChunks).values({
          orgId: fixture.orgId,
          sourceId: source.id,
          source: "source",
          chunkIndex: 0,
          content: "Expense reimbursement is settled within ten working days.",
          embedding: vector,
          embeddingModel: "seeded-purge-test",
        });

        const question = "expense reimbursement";
        const before = await ask.ask(asMember(reader, fixture.orgId), { question });
        expect(before.citations).toContainEqual(
          expect.objectContaining({ kind: "source", sourceId: source.id }),
        );

        /**
         * `DELETE /kb/sources/:id` runs inside the transaction
         * `TenantContextInterceptor` opens, and `kb_sources`' RLS policy is the raising
         * `org_id = current_org_id()`. Calling the service bare here would fail 42501 on
         * the harness rather than on the code under test, so the request's own context is
         * reproduced instead of removed.
         */
        await runInNewTenantTransaction(
          seededApp.app.get<Db>(DRIZZLE),
          fixture.orgId,
          () => sources.remove(fixture.orgId, source.id),
        );

        const remaining = await db
          .select({ id: kbArticleChunks.id })
          .from(kbArticleChunks)
          .where(
            and(
              eq(kbArticleChunks.orgId, fixture.orgId),
              eq(kbArticleChunks.sourceId, source.id),
            ),
          );
        expect(remaining).toEqual([]);

        const purged = await db.query.kbSources.findFirst({
          where: and(eq(kbSources.orgId, fixture.orgId), eq(kbSources.id, source.id)),
          columns: { deletedAt: true },
        });
        expect(purged?.deletedAt).not.toBeNull();

        const after = await ask.ask(asMember(reader, fixture.orgId), { question });
        expect(after.citations).not.toContainEqual(
          expect.objectContaining({ kind: "source", sourceId: source.id }),
        );
      } finally {
        embeddingOn.mockRestore();
        embedQuery.mockRestore();
        invoke.mockRestore();
        await fixture.teardown();
      }
    },
    180_000,
  );

  it(
    "converges a page's chunk rows on reindex and re-runs to a no-op",
    async () => {
      const fixture = await seedOrg(seededApp.seedDb).addMember("author").build();

      const db = seededApp.seedDb;
      const indexing = seededApp.app.get(KbIndexingService);
      const gateway = seededApp.app.get(AiGatewayService);
      const author = fixture.members["author"];
      if (!author) throw new Error("seed: reindex fixture member missing");

      const vector = unitVector();
      const embeddingOn = jest.spyOn(gateway, "isEmbeddingConfigured").mockReturnValue(true);
      const embedBatch = jest
        .spyOn(gateway, "embedBatchWithCredit")
        .mockImplementation(async (opts) => ({
          ok: true as const,
          vectors: opts.texts.map(() => vector),
        }));

      try {
        const contentText = "Release checklist. ".repeat(200).trim();
        const [page] = await db
          .insert(kbPages)
          .values({
            orgId: fixture.orgId,
            title: "Release checklist",
            contentText,
            visibility: "org",
            createdById: author.userId,
            createdByMembershipId: author.membershipId,
          })
          .returning({ id: kbPages.id, aclRevision: kbPages.aclRevision });
        if (!page) throw new Error("seed: page insert failed");

        /**
         * Seven rows that a previous indexing run would have left behind: the wrong
         * count, the wrong content hash and the wrong ACL revision. Reindex has to
         * REPLACE them, not add to them — an append would leave 7 + n rows and every
         * stale one would keep answering retrieval.
         */
        await db.insert(kbArticleChunks).values(
          Array.from({ length: 7 }, (_, index) => ({
            orgId: fixture.orgId,
            pageId: page.id,
            source: "page_body",
            chunkIndex: index,
            content: `STALE CHUNK ${index}`,
            contentHash: "stale-content-hash",
            embedding: vector,
            embeddingModel: "seeded-stale",
            pageVisibility: "org",
            aclRevision: page.aclRevision + 99,
          })),
        );

        const expectedChunks = chunkText(contentText).length;
        expect(expectedChunks).toBeGreaterThan(0);

        /**
         * Deliberately NOT wrapped. Both reindex routes carry `@NoTenantTransaction()`,
         * so the service really is entered with no ambient tenant context, and every
         * statement it makes has to supply its own. Wrapping this call would hide exactly
         * the defect the route hits in production.
         */
        const reindexed = await indexing.reindexPageOnRequest(fixture.orgId, page.id);
        expect(reindexed).toBe(expectedChunks);

        const rows = await db
          .select({
            content: kbArticleChunks.content,
            contentHash: kbArticleChunks.contentHash,
            aclRevision: kbArticleChunks.aclRevision,
          })
          .from(kbArticleChunks)
          .where(
            and(eq(kbArticleChunks.orgId, fixture.orgId), eq(kbArticleChunks.pageId, page.id)),
          );
        expect(rows).toHaveLength(expectedChunks);
        expect(rows.filter((row) => row.content.startsWith("STALE CHUNK"))).toEqual([]);
        expect([...new Set(rows.map((row) => row.contentHash))]).toEqual([sha256(contentText)]);
        expect([...new Set(rows.map((row) => row.aclRevision))]).toEqual([page.aclRevision]);

        const checkpoints = await db
          .select({ id: kbIngestionCheckpoints.id })
          .from(kbIngestionCheckpoints)
          .where(
            and(
              eq(kbIngestionCheckpoints.orgId, fixture.orgId),
              eq(kbIngestionCheckpoints.contentType, "page"),
              eq(kbIngestionCheckpoints.contentId, page.id),
            ),
          );
        expect(checkpoints).toEqual([]);

        const embedCallsAfterFirst = embedBatch.mock.calls.length;
        const second = await indexing.reindexPageOnRequest(fixture.orgId, page.id);
        expect(second).toBe(0);
        expect(embedBatch.mock.calls.length).toBe(embedCallsAfterFirst);

        const settled = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(kbArticleChunks)
          .where(
            and(eq(kbArticleChunks.orgId, fixture.orgId), eq(kbArticleChunks.pageId, page.id)),
          );
        expect(settled[0]?.count).toBe(expectedChunks);
      } finally {
        embeddingOn.mockRestore();
        embedBatch.mockRestore();
        await db.delete(kbPages).where(inArray(kbPages.orgId, [fixture.orgId]));
        await fixture.teardown();
      }
    },
    180_000,
  );
});
