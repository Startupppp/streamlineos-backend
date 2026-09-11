import { KbPageVisitsService } from "./kb-page-visits.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

jest.mock("../retrieval/kb-page-access.util", () => ({
  assertPageAccessible: jest.fn().mockResolvedValue(undefined),
}));

function makeUser(): CurrentUserContext {
  return { orgId: "org-1", userId: "user-1", isOrgOwner: true } as unknown as CurrentUserContext;
}

function makeDb(linkRows: Array<{ sourcePageId: number }>) {
  const limitFn = jest.fn().mockResolvedValue(linkRows);
  const where1 = jest.fn().mockReturnValue({ limit: limitFn });
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

describe("KbPageVisitsService.getBacklinks — 200-row cap", () => {
  beforeEach(() => jest.clearAllMocks());

  it("calls .limit(200) on the backlinks select so a widely-linked page is bounded in the DB", async () => {
    const { db, limitFn } = makeDb([]);
    const svc = new KbPageVisitsService(db as never);

    await svc.getBacklinks(makeUser(), 1);

    expect(limitFn).toHaveBeenCalledWith(200);
  });

  it("returns an empty array when there are no backlinks", async () => {
    const { db } = makeDb([]);
    const svc = new KbPageVisitsService(db as never);

    const result = await svc.getBacklinks(makeUser(), 1);

    expect(result).toEqual([]);
  });

  it("fetches pages for up to 200 backlink ids", async () => {
    const linkRows = Array.from({ length: 200 }, (_, i) => ({ sourcePageId: i + 1 }));
    const { db } = makeDb(linkRows);
    const svc = new KbPageVisitsService(db as never);

    await expect(svc.getBacklinks(makeUser(), 1)).resolves.not.toThrow();
  });
});
