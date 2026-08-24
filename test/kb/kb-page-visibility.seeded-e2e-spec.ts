import { eq, inArray } from "drizzle-orm";
import { kbPages } from "src/db/schema";
import { KbPagesService } from "src/modules/kb/wiki/kb-pages.service";
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
  permissions: [],
  sessionId: `seeded-${userId}`,
  tokenScopes: null,
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
});
