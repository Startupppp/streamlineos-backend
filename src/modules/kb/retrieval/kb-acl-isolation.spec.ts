import { KbSearchService } from "./kb-search.service";
import { KbMembersService } from "../wiki/kb-members.service";
import { kbPages, kbArticles } from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    ...overrides,
  };
}

const makeEmbeddings = () => ({
  isConfigured: jest.fn().mockReturnValue(false),
  embedQuery: jest.fn(),
  toVectorLiteral: jest.fn(),
});

const makeEvents = () => ({ record: jest.fn().mockResolvedValue(undefined) });

describe("KB cross-tenant isolation", () => {
  it("retrieveTopSources always applies the caller's orgId to the WHERE predicate", async () => {
    const capturedConditions: unknown[] = [];
    const chain: Record<string, jest.Mock> = {
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn((cond: unknown) => {
        capturedConditions.push(cond);
        return chain;
      }),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const db = {
      select: jest.fn().mockReturnValue(chain),
      execute: jest.fn().mockResolvedValue([]),
    };
    const access = {
      getAccessibleSpaceIds: jest.fn().mockResolvedValue([1]),
      getAccessibleProjectIds: jest.fn().mockResolvedValue([]),
      isAdmin: jest.fn().mockReturnValue(false),
      getPrincipalIds: jest.fn().mockResolvedValue({ userId: "user-1", roleSlugs: [] }),
    };

    const svc = new KbSearchService(
      db as never,
      access as never,
      makeEmbeddings() as never,
      makeEvents() as never,
    );

    await svc.retrieveTopSources(makeUser({ orgId: "org-a" }), "how do I reset my password", 4);

    expect(capturedConditions.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(capturedConditions);
    expect(serialized).toContain("org-a");
    expect(serialized).not.toContain("org-b");
  });

  it("retrieveTopArticles returns empty when access service finds no accessible spaces", async () => {
    const chain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const db = {
      select: jest.fn().mockReturnValue(chain),
      execute: jest.fn().mockResolvedValue([]),
    };
    const access = {
      getAccessibleSpaceIds: jest.fn().mockResolvedValue([]),
      getAccessibleProjectIds: jest.fn().mockResolvedValue([]),
      isAdmin: jest.fn().mockReturnValue(false),
      getPrincipalIds: jest.fn().mockResolvedValue({ userId: "user-b", roleSlugs: [] }),
    };

    const svc = new KbSearchService(
      db as never,
      access as never,
      makeEmbeddings() as never,
      makeEvents() as never,
    );

    const orgBUser = makeUser({ orgId: "org-b", userId: "user-b" });
    const result = await svc.retrieveTopArticles(orgBUser, "test", 5);
    expect(result).toEqual([]);
  });
});

describe("KB removed-member ACL revision mechanism", () => {
  function makeUpdateChain() {
    const chain = {
      set: jest.fn(),
      where: jest.fn().mockResolvedValue([]),
    };
    chain.set = jest.fn().mockReturnValue(chain);
    return chain;
  }

  function makeDeleteChain() {
    return { where: jest.fn().mockResolvedValue([]) };
  }

  function makeDb(member: Record<string, unknown>) {
    return {
      query: {
        kbSpaceMembers: {
          findFirst: jest.fn().mockResolvedValue(member),
        },
      },
      delete: jest.fn().mockReturnValue(makeDeleteChain()),
      update: jest.fn().mockReturnValue(makeUpdateChain()),
    };
  }

  it("removing a non-admin member bumps aclRevision on kbPages and kbArticles for that space", async () => {
    const member = {
      id: 10,
      orgId: "org-1",
      spaceId: 5,
      spaceRole: "member",
      userId: "user-2",
      role: null,
      team: null,
      createdAt: new Date(),
    };
    const db = makeDb(member);
    const access = { invalidateAccessibleSpaceIds: jest.fn().mockResolvedValue(undefined) };

    const svc = new KbMembersService(db as never, access as never);
    const result = await svc.remove("org-1", 5, 10);

    expect(result.success).toBe(true);
    const updatedTables = db.update.mock.calls.map(([table]: [unknown]) => table);
    expect(updatedTables).toContain(kbPages);
    expect(updatedTables).toContain(kbArticles);
  });

  it("removing a member also bumps aclRevision when the removed member held admin role", async () => {
    const member = {
      id: 11,
      orgId: "org-1",
      spaceId: 7,
      spaceRole: "admin",
      userId: "user-3",
      role: null,
      team: null,
      createdAt: new Date(),
    };
    const dbBase = makeDb(member);
    const countChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([{ count: 2 }]),
    };
    const db = {
      ...dbBase,
      select: jest.fn().mockReturnValue(countChain),
    };
    const access = { invalidateAccessibleSpaceIds: jest.fn().mockResolvedValue(undefined) };

    const svc = new KbMembersService(db as never, access as never);
    const result = await svc.remove("org-1", 7, 11);

    expect(result.success).toBe(true);
    const updatedTables = db.update.mock.calls.map(([table]: [unknown]) => table);
    expect(updatedTables).toContain(kbPages);
    expect(updatedTables).toContain(kbArticles);
  });
});
