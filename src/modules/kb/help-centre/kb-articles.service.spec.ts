jest.mock("./lib/kb-article-write", () => ({
  uniqueArticleSlug: jest.fn(),
  snapshotArticleVersion: jest.fn().mockResolvedValue(undefined),
  syncArticleTags: jest.fn().mockResolvedValue([]),
}));

import { ConflictException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../../test/postgres-error-fixture";
import { uniqueArticleSlug } from "./lib/kb-article-write";
import { KbArticlesService } from "./kb-articles.service";

/**
 * `create` picks a slug outside its transaction and inserts inside it, so two
 * authors who title an article the same thing at the same moment race on
 * uniq_kb_pages_org_slug_ref (org_id, slug). The loser's 23505 is the retry
 * signal: it should get a second slug, not a 500.
 */
describe("KbArticlesService.create — a slug that loses a race", () => {
  const ORG = "org-1";
  const PAGE_ROW = {
    id: 77,
    orgId: ORG,
    spaceId: 1,
    categoryId: null,
    title: "Doc",
    slug: "doc-2",
    excerpt: null,
    content: null,
    contentText: "",
    status: "draft",
    visibility: "org",
    createdById: "user-1",
    ownerMembershipId: 9,
    trustState: "unverified",
    verifiedUntil: null,
    views: 0,
    helpfulCount: 0,
    notHelpfulCount: 0,
    seoTitle: null,
    seoDescription: null,
    reviewIntervalDays: null,
    publishedAt: null,
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    aclRevision: 1,
    contentRevision: 1,
  };
  const user = {
    orgId: ORG,
    userId: "user-1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 9, isOrgOwner: false },
  } as never;
  const access = { assertSpaceAccessible: jest.fn().mockResolvedValue(undefined) } as never;
  const events = {} as never;
  const input = { spaceId: 1, title: "Doc", status: "draft" as const, visibility: "internal" as const };
  const slugFor = uniqueArticleSlug as jest.MockedFunction<typeof uniqueArticleSlug>;

  function makeTx(returning: jest.Mock) {
    const values = jest.fn().mockReturnValue({ returning });
    return { tx: { insert: jest.fn().mockReturnValue({ values }) }, values };
  }

  beforeEach(() => {
    slugFor.mockReset();
    slugFor.mockResolvedValueOnce("doc").mockResolvedValueOnce("doc-2").mockResolvedValue("doc-3");
  });

  it("retries with a fresh slug when the insert hits the slug unique", async () => {
    const lost = makeTx(jest.fn().mockRejectedValue(drizzleUniqueViolation("uniq_kb_pages_org_slug_ref")));
    const won = makeTx(jest.fn().mockResolvedValue([PAGE_ROW]));
    const transaction = jest
      .fn()
      .mockImplementationOnce((cb: (t: unknown) => unknown) => cb(lost.tx))
      .mockImplementationOnce((cb: (t: unknown) => unknown) => cb(won.tx));
    const service = new KbArticlesService({ transaction } as unknown as Db, access, events);

    const created = await service.create(user, input);

    expect(created).toMatchObject({ id: 77, slug: "doc-2", tags: [] });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(lost.values).toHaveBeenCalledWith(expect.objectContaining({ slug: "doc" }));
    expect(won.values).toHaveBeenCalledWith(expect.objectContaining({ slug: "doc-2" }));
  });

  it("stamps every created row as a support article so the help centre can find it back", async () => {
    const won = makeTx(jest.fn().mockResolvedValue([PAGE_ROW]));
    const transaction = jest.fn().mockImplementation((cb: (t: unknown) => unknown) => cb(won.tx));
    const service = new KbArticlesService({ transaction } as unknown as Db, access, events);

    await service.create(user, input);

    expect(won.values).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "support_article", visibility: "org" }),
    );
  });

  it("gives up after three lost races and surfaces the violation", async () => {
    const violation = drizzleUniqueViolation("uniq_kb_pages_org_slug_ref");
    const transaction = jest
      .fn()
      .mockImplementation((cb: (t: unknown) => unknown) => cb(makeTx(jest.fn().mockRejectedValue(violation)).tx));
    const service = new KbArticlesService({ transaction } as unknown as Db, access, events);

    await expect(service.create(user, input)).rejects.toBe(violation);
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("does not retry any other database error", async () => {
    const fkViolation = drizzlePostgresError("23503", "fk_kb_pages_org_space");
    const transaction = jest
      .fn()
      .mockImplementation((cb: (t: unknown) => unknown) => cb(makeTx(jest.fn().mockRejectedValue(fkViolation)).tx));
    const service = new KbArticlesService({ transaction } as unknown as Db, access, events);

    await expect(service.create(user, input)).rejects.toBe(fkViolation);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

describe("KbArticlesService.vote — a second rating from the same visitor", () => {
  const voter = {
    orgId: "org-1",
    userId: "user-1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 9, isOrgOwner: false },
  } as never;
  const viewable = { assertArticleViewable: jest.fn().mockResolvedValue(undefined) } as never;

  function makeVoteDb(insertRejects: boolean) {
    const setPatches: Record<string, unknown>[] = [];
    const tx = {
      insert: jest.fn().mockReturnValue({
        values: insertRejects
          ? jest
              .fn()
              .mockRejectedValue(drizzleUniqueViolation("uniq_kb_page_feedback_org_page_visitor"))
          : jest.fn().mockResolvedValue(undefined),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockImplementation((patch: Record<string, unknown>) => {
          setPatches.push(patch);
          return { where: jest.fn().mockResolvedValue(undefined) };
        }),
      }),
    };
    const db = {
      transaction: jest.fn().mockImplementation((cb: (t: unknown) => unknown) => cb(tx)),
    } as unknown as Db;
    return { db, setPatches };
  }

  it("answers 409 rather than 500 when the feedback unique index rejects the duplicate", async () => {
    const { db, setPatches } = makeVoteDb(true);
    const svc = new KbArticlesService(db, viewable, {} as never);

    await expect(svc.vote(voter, 5, { helpful: true })).rejects.toBeInstanceOf(ConflictException);
    expect(setPatches).toHaveLength(0);
  });

  it("records a first rating and moves the counter that rating belongs to", async () => {
    const helpful = makeVoteDb(false);
    await expect(
      new KbArticlesService(helpful.db, viewable, {} as never).vote(voter, 5, { helpful: true }),
    ).resolves.toEqual({ success: true });
    expect(helpful.setPatches[0]).toHaveProperty("helpfulCount");

    const unhelpful = makeVoteDb(false);
    await new KbArticlesService(unhelpful.db, viewable, {} as never).vote(voter, 5, { helpful: false });
    expect(unhelpful.setPatches[0]).toHaveProperty("notHelpfulCount");
  });

  it("does not convert an unrelated database failure into a conflict", async () => {
    const boom = new Error("connection reset");
    const tx = { insert: jest.fn().mockReturnValue({ values: jest.fn().mockRejectedValue(boom) }) };
    const db = {
      transaction: jest.fn().mockImplementation((cb: (t: unknown) => unknown) => cb(tx)),
    } as unknown as Db;

    await expect(
      new KbArticlesService(db, viewable, {} as never).vote(voter, 5, { helpful: true }),
    ).rejects.toBe(boom);
  });
});
