import { HttpException, HttpStatus, INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { KbIndexingService } from "../retrieval/kb-indexing.service";
import { KbArticlesService } from "../help-centre/kb-articles.service";
import { KbPagesService } from "./kb-pages.service";

const NOW = new Date("2026-02-01T09:00:00.000Z");

/** The full `kbPageSchema` shape, because the response contract interceptor enforces it under NODE_ENV=test. */
const UPDATED_PAGE = {
  id: 1,
  orgId: "org_1",
  spaceId: null,
  parentPageId: null,
  sortOrder: 0,
  projectId: null,
  title: "Renamed while someone else was typing",
  icon: null,
  coverImage: null,
  status: "draft",
  contentType: "note",
  trustState: "unverified",
  visibility: "org",
  publicToken: null,
  publicSlug: null,
  content: null,
  contentText: null,
  isLocked: false,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  createdByMembershipId: 1,
  lastEditedByMembershipId: 1,
  deletedByMembershipId: null,
  ownerMembershipId: null,
  verifiedByMembershipId: null,
  createdById: "user_1",
  lastEditedById: "user_1",
  deletedById: null,
  ownerUserId: null,
  verifiedById: null,
  verifiedUntil: null,
  nextReviewAt: null,
  aclRevision: 1,
  contentRevision: 4,
  sourceArticleId: null,
};

function staleRevision(subject: string): HttpException {
  return new HttpException(
    {
      message: `${subject} was modified by another editor. Reload to see the latest version.`,
      code: "STALE_REVISION",
    },
    HttpStatus.CONFLICT,
  );
}

const pagesService = { update: jest.fn() };
const articlesService = { update: jest.fn() };

describe("KB revision preconditions over HTTP (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: KbPagesService, useValue: pagesService },
        { provide: KbArticlesService, useValue: articlesService },
        { provide: KbIndexingService, useValue: {} },
      ],
    });
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    pagesService.update.mockReset();
    articlesService.update.mockReset();
  });

  async function editor(): Promise<string> {
    return signToken({
      permissions: ["kb:pages:update", "kb:articles:update"],
      enabledModules: ["kb"],
    });
  }

  function patchPage(token: string, body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .patch("/kb/pages/1")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
  }

  function patchArticle(token: string, body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .patch("/kb/articles/1")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
  }

  it("401 on PATCH /kb/pages/:pageId without a token", async () => {
    const res = await request(app.getHttpServer()).patch("/kb/pages/1").send({ title: "x" });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("403 on PATCH /kb/pages/:pageId without kb:pages:update", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["kb"] });
    const res = await patchPage(token, { title: "x" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
    expect(pagesService.update).not.toHaveBeenCalled();
  });

  it("400 on a page content write with no expectedContentRevision, naming the missing field", async () => {
    const token = await editor();

    const res = await patchPage(token, { content: { type: "doc", content: [] } });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(res.body.details).toContainEqual(
      expect.objectContaining({ path: "expectedContentRevision" }),
    );
    expect(pagesService.update).not.toHaveBeenCalled();
  });

  it("400 on a page content write that sends contentText but omits the precondition", async () => {
    const token = await editor();

    const res = await patchPage(token, {
      content: { type: "doc", content: [] },
      contentText: "hello",
      changeSummary: "typo",
    });

    expect(res.status).toBe(400);
    expect(res.body.details).toContainEqual(
      expect.objectContaining({ path: "expectedContentRevision" }),
    );
  });

  it.each([
    ["title", { title: "Renamed while someone else was typing" }],
    ["status", { status: "published" }],
    ["ownerUserId", { ownerUserId: "user_2" }],
  ])(
    "200 on a metadata-only page edit (%s) with no precondition — a rename is not gated on someone else's typing",
    async (_field, body) => {
      pagesService.update.mockResolvedValue(UPDATED_PAGE);
      const token = await editor();

      const res = await patchPage(token, body);

      expect(res.status).toBe(200);
      expect(pagesService.update).toHaveBeenCalledTimes(1);
      const [user, pageId, received] = pagesService.update.mock.calls[0] ?? [];
      expect(user).toMatchObject({ orgId: "org_1", userId: "user_1" });
      expect(pageId).toBe(1);
      expect(received).toEqual(body);
    },
  );

  it("409 STALE_REVISION — never 404 — when a page content write carries a stale precondition", async () => {
    pagesService.update.mockRejectedValue(staleRevision("Page"));
    const token = await editor();

    const res = await patchPage(token, {
      content: { type: "doc", content: [] },
      expectedContentRevision: 3,
    });

    expect(res.status).toBe(409);
    expect(res.status).not.toBe(404);
    expect(res.body).toMatchObject({
      code: "STALE_REVISION",
      message: "Page was modified by another editor. Reload to see the latest version.",
    });
  });

  it("passes the precondition through to the service exactly as sent", async () => {
    pagesService.update.mockResolvedValue(UPDATED_PAGE);
    const token = await editor();

    await patchPage(token, { content: { type: "doc", content: [] }, expectedContentRevision: 4 });

    const [, , received] = pagesService.update.mock.calls[0] ?? [];
    expect(received).toMatchObject({ expectedContentRevision: 4 });
  });

  it("401 on PATCH /kb/articles/:articleId without a token", async () => {
    const res = await request(app.getHttpServer()).patch("/kb/articles/1").send({ title: "x" });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("403 on PATCH /kb/articles/:articleId without kb:articles:update", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["kb"] });
    const res = await patchArticle(token, { title: "x", expectedContentRevision: 2 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
    expect(articlesService.update).not.toHaveBeenCalled();
  });

  it.each([
    ["a content write", { content: "<p>hi</p>" }],
    ["a title-only edit", { title: "Renamed" }],
  ])(
    "400 on %s of an article with no expectedContentRevision — the article precondition is unconditional",
    async (_case, body) => {
      const token = await editor();

      const res = await patchArticle(token, body);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
      expect(res.body.details).toContainEqual(
        expect.objectContaining({ path: "expectedContentRevision" }),
      );
      expect(articlesService.update).not.toHaveBeenCalled();
    },
  );

  it("409 STALE_REVISION — never 404 — when an article write carries a stale precondition", async () => {
    articlesService.update.mockRejectedValue(staleRevision("Article"));
    const token = await editor();

    const res = await patchArticle(token, { content: "<p>hi</p>", expectedContentRevision: 3 });

    expect(res.status).toBe(409);
    expect(res.status).not.toBe(404);
    expect(res.body).toMatchObject({
      code: "STALE_REVISION",
      message: "Article was modified by another editor. Reload to see the latest version.",
    });
  });
});
