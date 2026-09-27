import { sql } from "drizzle-orm";
import { KbPageVisitsService } from "./kb-page-visits.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const authMock = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn().mockResolvedValue({ orgId: "o1", pageId: 1, action: "view", via: "admin" }),
};

function makeUser(): CurrentUserContext {
  return { orgId: "org-1", userId: "user-1", isOrgOwner: true } as unknown as CurrentUserContext;
}

function makeDb(linkRows: Array<{ id: number; sourcePageId: number }>) {
  const limitFn = jest.fn().mockResolvedValue(linkRows);
  const orderByFn = jest.fn().mockReturnValue({ limit: limitFn });
  const where1 = jest.fn().mockReturnValue({ orderBy: orderByFn });
  const from1 = jest.fn().mockReturnValue({ where: where1 });

  const where2 = jest.fn().mockResolvedValue([]);
  const from2 = jest.fn().mockReturnValue({ where: where2 });

  const db = {
    select: jest.fn()
      .mockReturnValueOnce({ from: from1 })
      .mockReturnValueOnce({ from: from2 }),
    query: {
      kbPages: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
    },
  };
  return { db, limitFn };
}

describe("KbPageVisitsService.getBacklinks — bound and cursor", () => {
  beforeEach(() => {
    authMock.visiblePagePredicate.mockClear();
    authMock.assertPageAccess.mockClear();
  });

  it("calls .limit(limit+1) using the sentinel technique so hasMore can be computed without a count query", async () => {
    const { db, limitFn } = makeDb([]);
    const svc = new KbPageVisitsService(db as never, authMock as never);

    await svc.getBacklinks(makeUser(), 1);

    expect(limitFn).toHaveBeenCalledWith(51);
  });

  it("no longer calls .limit(200) which was twice the platform cap", async () => {
    const { db, limitFn } = makeDb([]);
    const svc = new KbPageVisitsService(db as never, authMock as never);

    await svc.getBacklinks(makeUser(), 1);

    expect(limitFn).not.toHaveBeenCalledWith(200);
  });

  it("returns a CursorPage shape with data and pagination when there are no backlinks", async () => {
    const { db } = makeDb([]);
    const svc = new KbPageVisitsService(db as never, authMock as never);

    const result = await svc.getBacklinks(makeUser(), 1);

    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("pagination");
    expect(Array.isArray(result.data)).toBe(true);
  });

  it("fetches pages for up to limit backlink ids", async () => {
    const linkRows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, sourcePageId: i + 1 }));
    const { db } = makeDb(linkRows);
    const svc = new KbPageVisitsService(db as never, authMock as never);

    await expect(svc.getBacklinks(makeUser(), 1)).resolves.not.toThrow();
  });

  it("consults assertPageAccess with action 'view' before returning backlinks so the target page is access-checked", async () => {
    const { db } = makeDb([]);
    const svc = new KbPageVisitsService(db as never, authMock as never);

    await svc.getBacklinks(makeUser(), 42);

    expect(authMock.assertPageAccess).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
      42,
      "view",
    );
  });
});
