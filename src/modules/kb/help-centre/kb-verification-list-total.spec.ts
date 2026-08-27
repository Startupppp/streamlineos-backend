import { KbVerificationService } from "./kb-verification.service";
import type { Db } from "../../../db/drizzle.module";
import type { KbAccessService } from "../core/kb-access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

// listDue counted first, then read the page — two round trips in series, and the count ran even for an empty space list.

const USER = { userId: "user-1", orgId: "org-1", isOrgOwner: false } as unknown as CurrentUserContext;

function buildHarness(rows: number, total: number, spaceIds: number[] = [1, 2]) {
  let statements = 0;
  const pageRows = Array.from({ length: rows }, (_, i) => ({
    total: String(total),
    id: i + 1,
    spaceId: 1,
    categoryId: null,
    title: `Article ${i + 1}`,
    slug: `article-${i + 1}`,
    ownerId: null,
    reviewIntervalDays: 30,
    lastVerifiedAt: null,
    updatedAt: new Date(0),
  }));

  const chain = (result: unknown): Record<string, unknown> => {
    const link: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy"]) link[m] = jest.fn(() => link);
    link["limit"] = jest.fn(() => link);
    link["offset"] = jest.fn(() => Promise.resolve(result));
    link["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return link;
  };

  const db = {
    select: jest.fn(() => {
      statements += 1;
      return chain(pageRows);
    }),
  } as unknown as Db;

  const access = {
    getAccessibleSpaceIds: jest.fn(() => Promise.resolve(spaceIds)),
  } as unknown as KbAccessService;

  return { service: new KbVerificationService(db, access), statements: () => statements };
}

describe("kb verification queue — the total costs no extra round trip", () => {
  it("reads the total out of the page query", async () => {
    const harness = buildHarness(10, 46);

    const result = await harness.service.listDue(USER, 1, 20);

    expect(result.total).toBe(46);
    expect(harness.statements()).toBe(1);
  });

  it("never returns the window column as part of an article", async () => {
    const harness = buildHarness(3, 3);

    const result = await harness.service.listDue(USER, 1, 20);

    for (const item of result.items) expect(item).not.toHaveProperty("total");
  });

  it("reports zero on an empty first page without counting again", async () => {
    const harness = buildHarness(0, 0);

    const result = await harness.service.listDue(USER, 1, 20);

    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(0);
    expect(harness.statements()).toBe(1);
  });

  it("issues no statement at all when the reader can see no space", async () => {
    const harness = buildHarness(5, 5, []);

    const result = await harness.service.listDue(USER, 1, 20);

    expect(result).toMatchObject({ items: [], total: 0, totalPages: 0 });
    expect(harness.statements()).toBe(0);
  });

  it("still caps the page at the platform ceiling", async () => {
    const harness = buildHarness(2, 2);

    const result = await harness.service.listDue(USER, 1, 500);

    expect(result.pageSize).toBe(100);
  });
});
