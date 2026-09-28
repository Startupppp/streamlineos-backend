import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { KbCandidateService } from "./kb-candidate.service";
import { KbSearchRetrievalService } from "./kb-search-retrieval.service";
import { KbMembersService } from "../wiki/kb-members.service";
import { KbIndexingService } from "./kb-indexing.service";
import { kbPages } from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const makeScopes = (scope = "all") => ({ scopeFor: jest.fn().mockResolvedValue(scope) });

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...overrides,
  };
}

const makeEmbeddings = () => ({
  isEmbeddingConfigured: jest.fn().mockReturnValue(false),
  embedQueryWithCredit: jest.fn(),
});

const makeEvents = () => ({ record: jest.fn().mockResolvedValue(undefined) });

function collectStrings(root: unknown): string[] {
  const seen = new WeakSet<object>();
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      found.push(node);
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const value of Object.values(node)) visit(value);
  };
  visit(root);
  return found;
}

const makeKbAuth = (spaceIds: number[] = [1]) => ({
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  articleRestrictionPredicate: jest.fn().mockResolvedValue(null),
  resolveStanding: jest.fn().mockResolvedValue({
    orgId: "org-1",
    userId: "user-1",
    membershipId: 1,
    roleSlugs: [],
    isOrgOwner: false,
    isKbAdmin: false,
    accessibleSpaceIds: spaceIds,
    accessibleProjectIds: [],
    permissionsVersion: 1,
  }),
  assertPageAccess: jest
    .fn()
    .mockResolvedValue({ orgId: "org-1", pageId: 1, action: "view", via: "admin" }),
});

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
      limit: jest.fn().mockResolvedValue([{ id: 1 }]),
    };
    const db = {
      select: jest.fn().mockReturnValue(chain),
      execute: jest.fn().mockResolvedValue([]),
    };
    const embeddings = {
      isEmbeddingConfigured: jest.fn().mockReturnValue(true),
      embedQueryWithCredit: jest.fn().mockResolvedValue({ ok: true, vector: [0.1, 0.2], vectorLiteral: "[0.1,0.2]" }),
    };

    const svc = new KbSearchRetrievalService(
      db as never,
      embeddings as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
      makeKbAuth([1]) as never,
    );

    await svc.retrieveTopSources(makeUser({ orgId: "org-a" }), "how do I reset my password", 4);

    expect(capturedConditions.length).toBeGreaterThan(0);
    const serialized = collectStrings(capturedConditions).join("\u0000");
    const dialect = new PgDialect();
    const tenantBound = capturedConditions
      .map((cond) => dialect.sqlToQuery(cond as SQL))
      .filter(({ sql: text }) => /"org_id"\s*=\s*\$\d+/i.test(text));

    expect(tenantBound.length).toBeGreaterThan(0);
    for (const { sql: text, params } of tenantBound) {
      const slot = /"org_id"\s*=\s*\$(\d+)/i.exec(text);
      expect(params[Number(slot?.[1]) - 1]).toBe("org-a");
    }
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
    const svc = new KbSearchRetrievalService(
      db as never,
      makeEmbeddings() as never,
      new KbCandidateService(db as never),
      makeScopes() as never,
      makeKbAuth([]) as never,
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
      execute: jest.fn().mockResolvedValue([]),
    };
  }

  const makeIndexing = (db: unknown) =>
    new KbIndexingService(db as never, undefined as never, undefined as never);

  it("removing a non-admin member bumps aclRevision on the one kbPages table for that space", async () => {
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

    const svc = new KbMembersService(db as never, access as never, makeIndexing(db) as never);
    const result = await svc.remove("org-1", 5, 10);

    expect(result.success).toBe(true);
    const updatedTables = db.update.mock.calls.map(([table]: [unknown]) => table);
    expect(updatedTables).toContain(kbPages);
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

    const svc = new KbMembersService(db as never, access as never, makeIndexing(db) as never);
    const result = await svc.remove("org-1", 7, 11);

    expect(result.success).toBe(true);
    const updatedTables = db.update.mock.calls.map(([table]: [unknown]) => table);
    expect(updatedTables).toContain(kbPages);
  });
});
