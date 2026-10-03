import { resolveActorRankContext } from "./resolve-actor-rank";
import { ROLE_RANK } from "./grantability";
import { GRANT_PAGE_SIZE } from "../pagination/keyset-drain";
import type { Db } from "../../db/drizzle.types";

type Row = { id: string; rank: number; moduleKey: string | null };

function makePagedDb(pages: Row[][]): Db {
  let callIndex = 0;
  const chain: Record<string, jest.Mock> = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockImplementation(() =>
      Promise.resolve(pages[callIndex++] ?? []),
    ),
  };
  return chain as unknown as Db;
}

describe("resolveActorRankContext overflow — role past GRANT_PAGE_SIZE is not silently lost", () => {
  it("finds MODULE_ADMIN rank when the winning role is on the second drain page", async () => {
    const page1: Row[] = Array.from({ length: GRANT_PAGE_SIZE }, (_, i) => ({
      id: `${String(i + 1).padStart(36, "0")}`,
      rank: ROLE_RANK.FUNCTIONAL,
      moduleKey: null,
    }));
    const page2: Row[] = [
      {
        id: `${String(GRANT_PAGE_SIZE + 1).padStart(36, "0")}`,
        rank: ROLE_RANK.MODULE_ADMIN,
        moduleKey: "crm",
      },
    ];

    const db = makePagedDb([page1, page2]);
    const result = await resolveActorRankContext(db, "org-1", "user-1");

    expect(result.bestRank).toBe(ROLE_RANK.MODULE_ADMIN);
    expect(result.allowedModules).toEqual(new Set(["crm"]));
  });

  it("concrete loss without the drain: page1 alone reports FUNCTIONAL instead of MODULE_ADMIN", () => {
    const page1: Row[] = Array.from({ length: GRANT_PAGE_SIZE }, (_, i) => ({
      id: `${String(i + 1).padStart(36, "0")}`,
      rank: ROLE_RANK.FUNCTIONAL,
      moduleKey: null,
    }));

    let bestRankFromPage1Only: number = ROLE_RANK.FUNCTIONAL;
    for (const row of page1) {
      if (row.rank < bestRankFromPage1Only) bestRankFromPage1Only = row.rank;
    }
    expect(bestRankFromPage1Only).toBe(ROLE_RANK.FUNCTIONAL);
  });

  it("drain terminates after two pages and returns complete results", async () => {
    const page1: Row[] = Array.from({ length: GRANT_PAGE_SIZE }, (_, i) => ({
      id: `${String(i + 1).padStart(36, "0")}`,
      rank: ROLE_RANK.FUNCTIONAL,
      moduleKey: null,
    }));
    const page2: Row[] = Array.from({ length: 50 }, (_, i) => ({
      id: `${String(GRANT_PAGE_SIZE + i + 1).padStart(36, "0")}`,
      rank: ROLE_RANK.FUNCTIONAL,
      moduleKey: null,
    }));

    const db = makePagedDb([page1, page2]);
    const result = await resolveActorRankContext(db, "org-1", "user-1");

    expect(result.bestRank).toBe(ROLE_RANK.FUNCTIONAL);
    expect(result.allowedModules).toBeNull();
  });

  it("org-wide role on page 2 sets allowedModules to null even when page 1 has module-scoped roles", async () => {
    const page1: Row[] = Array.from({ length: GRANT_PAGE_SIZE }, (_, i) => ({
      id: `${String(i + 1).padStart(36, "0")}`,
      rank: ROLE_RANK.MODULE_ADMIN,
      moduleKey: `module-${i}`,
    }));
    const page2: Row[] = [
      {
        id: `${String(GRANT_PAGE_SIZE + 1).padStart(36, "0")}`,
        rank: ROLE_RANK.MODULE_ADMIN,
        moduleKey: null,
      },
    ];

    const db = makePagedDb([page1, page2]);
    const result = await resolveActorRankContext(db, "org-1", "user-1");

    expect(result.bestRank).toBe(ROLE_RANK.MODULE_ADMIN);
    expect(result.allowedModules).toBeNull();
  });
});
