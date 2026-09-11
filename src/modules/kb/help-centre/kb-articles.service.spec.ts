jest.mock("./lib/kb-article-write", () => ({
  uniqueArticleSlug: jest.fn(),
  snapshotArticleVersion: jest.fn().mockResolvedValue(undefined),
  syncArticleTags: jest.fn().mockResolvedValue([]),
}));

import type { Db } from "../../../db/drizzle.module";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../../test/postgres-error-fixture";
import { uniqueArticleSlug } from "./lib/kb-article-write";
import { KbArticlesService } from "./kb-articles.service";

/**
 * `create` picks a slug outside its transaction and inserts inside it, so two
 * authors who title an article the same thing at the same moment race on
 * uniq_kb_articles_org_slug (org_id, slug). The loser's 23505 is the retry
 * signal: it should get a second slug, not a 500.
 */
describe("KbArticlesService.create — a slug that loses a race", () => {
  const ORG = "org-1";
  const ARTICLE_ROW = { id: 77, orgId: ORG, title: "Doc", slug: "doc-2" };
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
    const lost = makeTx(jest.fn().mockRejectedValue(drizzleUniqueViolation("uniq_kb_articles_org_slug")));
    const won = makeTx(jest.fn().mockResolvedValue([ARTICLE_ROW]));
    const transaction = jest
      .fn()
      .mockImplementationOnce((cb: (t: unknown) => unknown) => cb(lost.tx))
      .mockImplementationOnce((cb: (t: unknown) => unknown) => cb(won.tx));
    const service = new KbArticlesService({ transaction } as unknown as Db, access, events);

    await expect(service.create(user, input)).resolves.toEqual({ ...ARTICLE_ROW, tags: [] });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(lost.values).toHaveBeenCalledWith(expect.objectContaining({ slug: "doc" }));
    expect(won.values).toHaveBeenCalledWith(expect.objectContaining({ slug: "doc-2" }));
  });

  it("gives up after three lost races and surfaces the violation", async () => {
    const violation = drizzleUniqueViolation("uniq_kb_articles_org_slug");
    const transaction = jest
      .fn()
      .mockImplementation((cb: (t: unknown) => unknown) => cb(makeTx(jest.fn().mockRejectedValue(violation)).tx));
    const service = new KbArticlesService({ transaction } as unknown as Db, access, events);

    await expect(service.create(user, input)).rejects.toBe(violation);
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("does not retry any other database error", async () => {
    const fkViolation = drizzlePostgresError("23503", "fk_kb_articles_space");
    const transaction = jest
      .fn()
      .mockImplementation((cb: (t: unknown) => unknown) => cb(makeTx(jest.fn().mockRejectedValue(fkViolation)).tx));
    const service = new KbArticlesService({ transaction } as unknown as Db, access, events);

    await expect(service.create(user, input)).rejects.toBe(fkViolation);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
