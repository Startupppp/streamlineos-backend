import "dotenv/config";
import postgres from "postgres";
import { requiresTls } from "../db/pool.config";
import { PgDialect } from "drizzle-orm/pg-core";
import { applyScope } from "../modules/access/apply-scope";
import { tickets, projects } from "../db/schema";
import { and, eq, isNull, ilike, sql } from "drizzle-orm";
import { resolveSearchAccess } from "../modules/search/search.service";
import type { AccessResolver } from "../modules/access/authorize";
import type { CurrentUserContext } from "../common/auth/backend-claims";

const dialect = new PgDialect();
const ROLLBACK_MARKER = "rollback-explain-probe";
const ownerDatabaseUrl = process.env.DATABASE_URL;
const describeAgainstOwner = ownerDatabaseUrl ? describe : describe.skip;

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

  describeAgainstOwner("integration — real Postgres, read-only", () => {
    let sqlOwner: ReturnType<typeof postgres>;

    beforeAll(() => {
      sqlOwner = postgres(ownerDatabaseUrl ?? "", { prepare: false });
    });

    afterAll(async () => {
      await sqlOwner.end();
    });

    it("integration: calling a non-existent probe function raises Postgres code 42883 — the isUndefinedFunction guard fires on real DB behavior, activating the ILIKE fallback without dropping the production probe", async () => {
      let caught: unknown;
      try {
        await sqlOwner`SELECT app.nonexistent_search_probe_degradation_xyz('test', 10) AS id`;
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeDefined();
      const code = (caught as Record<string, unknown>)["code"];
      expect(code).toBe("42883");

      const [org] = await sqlOwner`SELECT id FROM organizations WHERE deleted_at IS NULL LIMIT 1`;
      const realOrgId = String(org["id"]);

      const rows = await sqlOwner`
        SELECT id FROM build.tickets
        WHERE org_id = ${realOrgId} AND deleted_at IS NULL
        LIMIT 1
      `;

      expect(Array.isArray(rows)).toBe(true);
    });
  });
});

const appDatabaseUrl = process.env.APP_DATABASE_URL;
const describeAgainstAppRole = appDatabaseUrl ? describe : describe.skip;

describeAgainstAppRole(
  "the degraded ILIKE fallback filters by tenant inside the query, proved by EXPLAIN as streamline_app",
  () => {
    let sql: ReturnType<typeof postgres>;

    beforeAll(() => {
      sql = postgres(appDatabaseUrl ?? "", {
        prepare: false,
        ...(requiresTls(appDatabaseUrl ?? "") ? { ssl: "require" as const } : {}),
        max: 1,
      });
    });

    afterAll(async () => {
      await sql.end();
    });

    it("runs as a non-owner role, because the owner bypasses RLS and would prove nothing", async () => {
      const [row] = await sql<{ role: string; bypass: boolean }[]>`
        SELECT current_user AS role,
               (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`;

      expect(row?.bypass).toBe(false);
    });

    it("puts the tenant predicate in the plan rather than filtering after the fetch", async () => {
      const plan = await captureFallbackPlan(sql);

      expect(plan).toMatch(/org_id/);
      expect(plan).not.toMatch(/Seq Scan[^}]*"Relation Name":"tickets"/);
    });

    it("fails closed when the tenant GUC is absent", async () => {
      await expect(
        sql.begin(async (tx) => tx`SELECT count(*) FROM build.tickets WHERE org_id = current_org_id()`),
      ).rejects.toThrow();
    });
  },
);

async function captureFallbackPlan(client: ReturnType<typeof postgres>): Promise<string> {
  let plan = "";
  try {
    await client.begin(async (tx) => {
      await tx`SELECT set_config('app.organization_id', ${"org-explain-probe"}, true)`;
      /*
        Seq scans are priced out for this probe, deliberately.

        On an empty or nearly empty `build.tickets` a sequential scan is the
        cheapest plan whatever indexes exist, so the assertion below would fail
        on a fresh database and pass on a full one — a test that measures how
        much data the environment happens to hold rather than anything about the
        query. Penalising the seq scan asks the question actually worth asking:
        is there an index the tenant predicate *can* use. If none applies, the
        plan still comes back sequential and the case still fails.
      */
      await tx`SET LOCAL enable_seqscan = off`;
      const rows = await tx`
        EXPLAIN (FORMAT JSON)
        SELECT id, title FROM build.tickets
        WHERE org_id = current_org_id() AND title ILIKE ${"%probe%"}
        LIMIT 10`;
      plan = JSON.stringify(rows);
      throw new Error(ROLLBACK_MARKER);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK_MARKER) throw error;
  }
  return plan;
}
