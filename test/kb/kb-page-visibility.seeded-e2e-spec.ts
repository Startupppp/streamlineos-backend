import { eq, inArray } from "drizzle-orm";
import { kbArticleChunks, kbPages } from "src/db/schema";
import { KbPagesService } from "src/modules/kb/wiki/kb-pages.service";
import { KbSearchService } from "src/modules/kb/retrieval/kb-search.service";
import { EmbeddingsService } from "src/modules/ai/core/providers/embeddings.service";
import { KB_EMBEDDING_DIMENSIONS } from "src/db/schema/support/kb-chunks";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import type { CurrentUserContext } from "src/common/auth/backend-claims";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

const asMember = (userId: string, orgId: string): CurrentUserContext => ({
  userId,
  orgId,
  isOrgOwner: false,
  role: "MEMBER",
  sessionId: `seeded-${userId}`,
  tokenScopes: null,
  principal: { kind: "human-session", membershipId: 1, isOrgOwner: false },
});

describe("[seeded-e2e] a page that belongs to a project", () => {
  let seededApp: SeededE2eApp;

  const asReader = async <T>(orgId: string, work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(seededApp.app.get<Db>(DRIZZLE), orgId, work);

  beforeAll(async () => {
    seededApp = await createSeededE2eApp();
  }, 120_000);

  afterAll(async () => {
    await seededApp.close();
  });

  it(
    "is readable by that project's member and not by a colleague outside it",
    async () => {
      const fixture = await seedOrg(seededApp.seedDb)
        .addMember("insider")
        .addMember("outsider")
        .addProject("alpha")
        .addProject("beta")
        .addProjectMember("alpha", "insider")
        .addProjectMember("beta", "outsider")
        .build();

      const db = seededApp.seedDb;
      const pages = seededApp.app.get(KbPagesService);
      const insider = fixture.members["insider"];
      const outsider = fixture.members["outsider"];
      if (!insider || !outsider) throw new Error("fixture members missing");
      const alpha = fixture.projects["alpha"];
      if (!alpha) throw new Error("fixture project alpha missing");

      const created: number[] = [];
      try {
        const [shared] = await db
          .insert(kbPages)
          .values({
            orgId: fixture.orgId,
            title: "Company handbook",
            visibility: "org",
            projectId: null,
            createdById: outsider.userId,
          })
          .returning({ id: kbPages.id });

        const [projectPage] = await db
          .insert(kbPages)
          .values({
            orgId: fixture.orgId,
            title: "Alpha launch plan",
            visibility: "org",
            projectId: alpha.projectId,
            createdById: insider.userId,
          })
          .returning({ id: kbPages.id });

        if (!shared || !projectPage) throw new Error("seed: page insert failed");
        created.push(shared.id, projectPage.id);

        const insiderCtx = asMember(insider.userId, fixture.orgId);
        const outsiderCtx = asMember(outsider.userId, fixture.orgId);

        await expect(
          asReader(fixture.orgId, () => pages.get(insiderCtx, projectPage.id, false)),
        ).resolves.toMatchObject({ id: projectPage.id });

        await expect(
          asReader(fixture.orgId, () => pages.get(outsiderCtx, projectPage.id, false)),
        ).rejects.toMatchObject({ status: 404 });

        await expect(
          asReader(fixture.orgId, () => pages.get(outsiderCtx, shared.id, false)),
        ).resolves.toMatchObject({ id: shared.id });
      } finally {
        if (created.length > 0)
          await db.delete(kbPages).where(inArray(kbPages.id, created));
        await fixture.teardown();
      }
    },
    120_000,
  );

  it(
    "keeps its author's access after they leave the project",
    async () => {
      const fixture = await seedOrg(seededApp.seedDb)
        .addMember("author")
        .addProject("gamma")
        .build();

      const db = seededApp.seedDb;
      const pages = seededApp.app.get(KbPagesService);
      const author = fixture.members["author"];
      const gamma = fixture.projects["gamma"];
      if (!author || !gamma) throw new Error("fixture missing");

      let pageId: number | null = null;
      try {
        const [own] = await db
          .insert(kbPages)
          .values({
            orgId: fixture.orgId,
            title: "Notes I wrote",
            visibility: "org",
            projectId: gamma.projectId,
            createdById: author.userId,
          })
          .returning({ id: kbPages.id });
        if (!own) throw new Error("seed: page insert failed");
        pageId = own.id;

        await expect(
          asReader(fixture.orgId, () =>
            pages.get(asMember(author.userId, fixture.orgId), own.id, false),
          ),
        ).resolves.toMatchObject({ id: own.id });
      } finally {
        if (pageId !== null) await db.delete(kbPages).where(eq(kbPages.id, pageId));
        await fixture.teardown();
      }
    },
    120_000,
  );

  it(
    "keeps direct reads, keyword page search, and vector retrieval on the same visibility result",
    async () => {
      const fixture = await seedOrg(seededApp.seedDb)
        .addMember("insider")
        .addMember("outsider")
        .addProject("parity")
        .addProjectMember("parity", "insider")
        .build();

      const db = seededApp.seedDb;
      const pages = seededApp.app.get(KbPagesService);
      const search = seededApp.app.get(KbSearchService);
      const embeddings = seededApp.app.get(EmbeddingsService);
      const insider = fixture.members["insider"];
      const outsider = fixture.members["outsider"];
      const project = fixture.projects["parity"];
      if (!insider || !outsider || !project) throw new Error("seed: parity fixture missing");

      const vector = Array.from({ length: KB_EMBEDDING_DIMENSIONS }, (_, index) =>
        index === 0 ? 1 : 0,
      );
      const created: { pageId: number; chunkId: number } = { pageId: 0, chunkId: 0 };
      const query = "seeded parity needle";
      const insiderCtx = asMember(insider.userId, fixture.orgId);
      const outsiderCtx = asMember(outsider.userId, fixture.orgId);

      // This is the production KbSearchService against the seeded database.
      // Only the external embedding request is deterministic here; the pgvector
      // candidate query, denormalized ACL columns, and final page re-check are real.
      const configured = jest.spyOn(embeddings, "isConfigured").mockReturnValue(true);
      const embedQuery = jest.spyOn(embeddings, "embedQuery").mockResolvedValue(vector);
      try {
        const [page] = await db
          .insert(kbPages)
          .values({
            orgId: fixture.orgId,
            title: "Seeded parity needle",
            contentText: "This seeded parity needle is visible only to the project member.",
            visibility: "org",
            projectId: project.projectId,
            createdById: insider.userId,
          })
          .returning({ id: kbPages.id });
        if (!page) throw new Error("seed: parity page insert failed");
        created.pageId = page.id;

        const [chunk] = await db
          .insert(kbArticleChunks)
          .values({
            orgId: fixture.orgId,
            pageId: page.id,
            source: "page_body",
            chunkIndex: 0,
            content: "This seeded parity needle is the vector chunk.",
            embedding: vector,
            embeddingModel: "seeded-parity-test",
            pageVisibility: "org",
            pageProjectId: project.projectId,
            pageCreatedById: insider.userId,
          })
          .returning({ id: kbArticleChunks.id });
        if (!chunk) throw new Error("seed: parity chunk insert failed");
        created.chunkId = chunk.id;

        const read = await asReader(fixture.orgId, () => pages.get(insiderCtx, page.id, false));
        expect(read.id).toBe(page.id);

        const keyword = await asReader(fixture.orgId, () => pages.search(insiderCtx, query));
        expect(keyword.map((row) => row.id)).toContain(page.id);

        const vectorResults = await asReader(fixture.orgId, () =>
          search.retrieveTopArticles(insiderCtx, query, 5),
        );
        expect(vectorResults.filter((row) => row.kind === "page").map((row) => row.id)).toContain(page.id);

        await expect(
          asReader(fixture.orgId, () => pages.get(outsiderCtx, page.id, false)),
        ).rejects.toMatchObject({ status: 404 });

        const outsiderKeyword = await asReader(fixture.orgId, () => pages.search(outsiderCtx, query));
        expect(outsiderKeyword.map((row) => row.id)).not.toContain(page.id);

        const outsiderVector = await asReader(fixture.orgId, () =>
          search.retrieveTopArticles(outsiderCtx, query, 5),
        );
        expect(outsiderVector.filter((row) => row.kind === "page").map((row) => row.id)).not.toContain(page.id);
        expect(embedQuery).toHaveBeenCalledWith(query);
      } finally {
        configured.mockRestore();
        embedQuery.mockRestore();
        if (created.chunkId > 0) await db.delete(kbArticleChunks).where(eq(kbArticleChunks.id, created.chunkId));
        if (created.pageId > 0) await db.delete(kbPages).where(eq(kbPages.id, created.pageId));
        await fixture.teardown();
      }
    },
    120_000,
  );
});
