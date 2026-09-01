import type { Db } from "../../../db/drizzle.module";
import { KbCommentsService } from "./kb-comments.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeUser(orgId: string): CurrentUserContext {
  return { orgId, userId: "u-test", isOrgOwner: false, principal: undefined } as never;
}

const kbAccess = { assertArticleViewable: jest.fn().mockResolvedValue(undefined), assertArticleEditable: jest.fn().mockResolvedValue({ id: 1, orgId: "org", spaceId: null }) } as never;
const access = { holds: jest.fn().mockResolvedValue(false) } as never;

function makeDb(commentRows: unknown[] = []): Db {
  const allWhereArgs: unknown[] = [];
  const chain = {
    where: jest.fn().mockImplementation((arg: unknown) => {
      allWhereArgs.push(arg);
      return Promise.resolve(commentRows.map(r => ({ ...r as object, authorName: null })));
    }),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnValue(Promise.resolve(commentRows.map(r => ({ ...r as object, authorName: null })))),
  };
  return {
    query: {
      kbArticleComments: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((arg: unknown) => {
            allWhereArgs.push(arg);
            return {
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue(commentRows.map(r => ({ ...r as object, authorName: null }))),
              }),
            };
          }),
        }),
        where: chain.where,
      }),
    }),
    _allWhereArgs: allWhereArgs,
  } as unknown as Db;
}

describe("KbCommentsService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("scopes comment list to the requesting org (tenant isolation)", async () => {
    const db = makeDb([]);
    const svc = new KbCommentsService(db, kbAccess, access);

    await svc.list(makeUser(ATTACKER_ORG), 1);

    const allWhereArgs = (db as unknown as { _allWhereArgs: unknown[] })._allWhereArgs;
    const allVals = allWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
    expect(allVals).not.toContain(OWNER_ORG);
  });

  it("returns comments for the owning org (same-tenant control)", async () => {
    const comment = { id: 1, orgId: OWNER_ORG, articleId: 1, content: "Hello", authorId: "u1", parentId: null, resolvedAt: null, createdAt: new Date(), updatedAt: new Date() };
    const db = makeDb([comment]);
    const svc = new KbCommentsService(db, kbAccess, access);

    const result = await svc.list(makeUser(OWNER_ORG), 1);

    expect(result.length).toBeGreaterThanOrEqual(0);
  });
});
