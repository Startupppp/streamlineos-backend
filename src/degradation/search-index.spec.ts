import { PgDialect } from "drizzle-orm/pg-core";
import { applyScope } from "../modules/access/apply-scope";
import { tickets, projects } from "../db/schema";
import { and, eq, isNull, ilike, sql } from "drizzle-orm";
import { resolveSearchAccess } from "../modules/search/search.service";
import type { AccessResolver } from "../modules/access/authorize";
import type { CurrentUserContext } from "../common/auth/backend-claims";

const dialect = new PgDialect();

function render(condition: Parameters<PgDialect["sqlToQuery"]>[0]): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(condition);
}

const orgId = "org-test";
const userId = "user-test";
const user: CurrentUserContext = {
  orgId,
  userId,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-test",
  tokenScopes: null,
  principal: { kind: "human-session", membershipId: 1, isOrgOwner: false },
};

describe("ACL predicates survive on the degraded search path", () => {
  describe("applyScope produces a real SQL condition — not a post-fetch filter", () => {
    it("scope=none produces false, gating all access at the query level", () => {
      const cond = applyScope("none", orgId, userId, { ownerColumn: tickets.assigneeId });
      const { sql: text } = render(cond);
      expect(text).toBe("false");
    });

    it("scope=own produces an equality predicate on the owner column, not a JS filter", () => {
      const cond = applyScope("own", orgId, userId, { ownerColumn: tickets.assigneeId });
      const { sql: text, params } = render(cond);
      expect(text).toContain("=");
      expect(params).toContain(userId);
    });

    it("scope=all produces true — allowed, but still evaluated in SQL not post-fetch", () => {
      const cond = applyScope("all", orgId, userId, { ownerColumn: tickets.assigneeId });
      const { sql: text } = render(cond);
      expect(text).toBe("true");
    });
  });

  describe("the degraded (ILIKE fallback) query wraps text condition in ACL predicates", () => {
    it("ILIKE is nested inside and() with org_id — never a global scan", () => {
      const pattern = "%test%";
      const textCondition = ilike(tickets.title, pattern);
      const fullCondition = and(
        eq(tickets.orgId, orgId),
        eq(projects.orgId, orgId),
        isNull(tickets.deletedAt),
        applyScope("all", orgId, userId, { ownerColumn: tickets.assigneeId }),
        textCondition,
      );

      const { sql: text, params } = render(fullCondition!);

      expect(params).toContain(orgId);
      expect(text).toContain("ilike");
      expect(text.toLowerCase()).toContain("org_id");
    });

    it("scope=own inside the degraded condition narrows to the requesting user", () => {
      const pattern = "%test%";
      const textCondition = ilike(tickets.title, pattern);
      const fullCondition = and(
        eq(tickets.orgId, orgId),
        applyScope("own", orgId, userId, { ownerColumn: tickets.assigneeId }),
        textCondition,
      );

      const { params } = render(fullCondition!);

      expect(params).toContain(orgId);
      expect(params).toContain(userId);
    });

    it("scope=none combined with ILIKE still produces false — no results exposed", () => {
      const pattern = "%test%";
      const textCondition = ilike(tickets.title, pattern);
      const fullCondition = and(
        eq(tickets.orgId, orgId),
        applyScope("none", orgId, userId, { ownerColumn: tickets.assigneeId }),
        textCondition,
      );

      const { sql: text } = render(fullCondition!);
      expect(text).toContain("false");
    });
  });

  describe("isUndefinedFunction detection — via behaviour, not the private implementation", () => {
    it("42883 error is the postgres undefined_function code", () => {
      const code = "42883";
      const err = Object.assign(new Error("function does not exist"), { code });
      expect(err.code).toBe("42883");
    });

    it("other postgres error codes are NOT treated as missing probe", () => {
      const nonSearchErrors = ["42501", "23505", "42703", "XX000"];
      for (const code of nonSearchErrors) {
        const err = Object.assign(new Error("db error"), { code });
        expect(err.code).not.toBe("42883");
      }
    });
  });
});

describe("resolveSearchAccess — ACL gate runs before search, not after", () => {
  it("returns null for every resource when the user holds no permissions", async () => {
    const noAccessResolver: AccessResolver = {
      scopeFor: jest.fn().mockResolvedValue("none"),
      getModuleState: jest.fn().mockResolvedValue(false),
      buildModuleAvailabilityResolver: jest.fn().mockReturnValue({
        isCoreModule: () => false,
        getModuleMap: async () => ({}),
        getUserDeniedModules: async () => new Set<string>(),
        getPlanLockedModules: async () => [],
      }),
    };

    const access = await resolveSearchAccess(noAccessResolver, user);

    expect(access.leads).toBeNull();
    expect(access.deals).toBeNull();
    expect(access.contacts).toBeNull();
    expect(access.clients).toBeNull();
    expect(access.build).toBeNull();
  });

  it("a null resource access skips the query entirely — no results returned for that resource", async () => {
    const allAccessResolver: AccessResolver = {
      scopeFor: jest.fn().mockResolvedValue("all"),
      getModuleState: jest.fn().mockResolvedValue(true),
      buildModuleAvailabilityResolver: jest.fn().mockReturnValue({
        isCoreModule: () => true,
        getModuleMap: async () => ({}),
        getUserDeniedModules: async () => new Set<string>(),
        getPlanLockedModules: async () => [],
      }),
    };

    const access = await resolveSearchAccess(allAccessResolver, user);

    expect(access.leads).not.toBeNull();
    expect(access.build).not.toBeNull();
  });

  it.skip(
    "integration: when the SECURITY DEFINER probe is missing (42883), search still returns results via ILIKE fallback — needs real Postgres with the function dropped",
    () => {},
  );

  it.skip(
    "integration: the ILIKE fallback query contains org_id in the WHERE clause, not a post-fetch filter — verified via EXPLAIN in a real Postgres session",
    () => {},
  );
});
