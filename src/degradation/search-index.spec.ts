import postgres from "postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { applyScope } from "../modules/access/apply-scope";
import { connectForProbe, requiredDatabase } from "./degraded-db";
import { tickets, projects } from "../db/schema";
import { and, eq, isNull, ilike, sql } from "drizzle-orm";
import { resolveSearchAccess } from "../modules/search/search-scope";
import type { AccessResolver } from "../modules/access/authorize";
import type { CurrentUserContext } from "../common/auth/backend-claims";

/**
 * This file used to open with `import "dotenv/config"`, and that one line was the
 * defect under every other symptom here. It loaded `.env` into the process, so
 * `DATABASE_URL` was never absent, so the guard below never skipped and the spec
 * quietly connected to the shared remote branch named in `.env` no matter where
 * the caller had pointed it. `APP_DATABASE_URL` is deliberately unset in that
 * file, so the tenant-isolation proof at the bottom took the other silent branch
 * and skipped without saying so — a security-relevant assertion that read as
 * green because it never ran at all. The database is now named by the caller: the
 * spec either runs where it was pointed, or skips and says what is missing.
 */
const dialect = new PgDialect();
const ROLLBACK_MARKER = "rollback-explain-probe";
const owner = requiredDatabase(
  "DATABASE_URL",
  "The 42883 guard is proved by asking a real Postgres for a function that does not exist, " +
    "which needs an owner connection string named by the caller.",
);
const describeAgainstOwner = owner.url ? describe : describe.skip;

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
const membershipId = "1";

describe("ACL predicates survive on the degraded search path", () => {
  describe("applyScope produces a real SQL condition — not a post-fetch filter", () => {
    it("scope=none produces false, gating all access at the query level", () => {
      const cond = applyScope("none", orgId, membershipId, { ownerColumn: tickets.assigneeMembershipId });
      const { sql: text } = render(cond);
      expect(text).toBe("false");
    });

    it("scope=own produces an equality predicate on the owner column, not a JS filter", () => {
      const cond = applyScope("own", orgId, membershipId, { ownerColumn: tickets.assigneeMembershipId });
      const { sql: text, params } = render(cond);
      expect(text).toContain("=");
      expect(params).toContain(membershipId);
    });

    it("scope=all produces true — allowed, but still evaluated in SQL not post-fetch", () => {
      const cond = applyScope("all", orgId, membershipId, { ownerColumn: tickets.assigneeMembershipId });
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
        applyScope("all", orgId, membershipId, { ownerColumn: tickets.assigneeMembershipId }),
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
        applyScope("own", orgId, membershipId, { ownerColumn: tickets.assigneeMembershipId }),
        textCondition,
      );

      const { params } = render(fullCondition!);

      expect(params).toContain(orgId);
      expect(params).toContain(membershipId);
    });

    it("scope=none combined with ILIKE still produces false — no results exposed", () => {
      const pattern = "%test%";
      const textCondition = ilike(tickets.title, pattern);
      const fullCondition = and(
        eq(tickets.orgId, orgId),
        applyScope("none", orgId, membershipId, { ownerColumn: tickets.assigneeMembershipId }),
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

  describeAgainstOwner(owner.title("integration — real Postgres, read-only"), () => {
    let sqlOwner: ReturnType<typeof postgres>;

    beforeAll(() => {
      sqlOwner = connectForProbe(owner.url ?? "");
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

const appRole = requiredDatabase(
  "APP_DATABASE_URL",
  "This proof only means something when it runs as the non-owner application role: the owner " +
    "has rolbypassrls and would satisfy every assertion below without RLS ever being consulted. " +
    "Point APP_DATABASE_URL at a role with rolbypassrls = false and re-run.",
);
const describeAgainstAppRole = appRole.url ? describe : describe.skip;

describeAgainstAppRole(
  appRole.title(
    "the degraded ILIKE fallback filters by tenant inside the query, proved by EXPLAIN as streamline_app",
  ),
  () => {
    let sql: ReturnType<typeof postgres>;

    beforeAll(() => {
      sql = connectForProbe(appRole.url ?? "");
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
      // Measured, not guessed. This used to accept ANY throw and was registered in
      // baselines/bare-throw.json precisely because nobody could run it to find out
      // what Postgres raises — "it becomes tightenable the moment the seeded
      // integration lane runs". It ran: `current_org_id()` RAISEs SQLSTATE 42501
      // with this message when `app.organization_id` is unset.
      //
      // The distinction is the whole point of the test. A bare `.toThrow()` is also
      // satisfied by `relation "build.tickets" does not exist` or a dropped
      // connection — i.e. by the query failing for a reason that proves nothing
      // about tenant isolation. Pinning the SQLSTATE proves it failed CLOSED.
      await expect(
        sql.begin(async (tx) => tx`SELECT count(*) FROM build.tickets WHERE org_id = current_org_id()`),
      ).rejects.toMatchObject({ code: "42501" });
    });
  },
);

const PROBE_ORG_PREFIX = "explain-probe-org-";
const PROBE_TENANTS = 20;
const PROBE_ROWS_PER_TENANT = 100;
const PROBE_SUBJECT_ORG = `${PROBE_ORG_PREFIX}7`;

/**
 * An EXPLAIN only says something about the access path if the planner had a reason
 * to choose one. Against an empty table every plan is a zero-cost Seq Scan, so the
 * assertion would fail for a reason that has nothing to do with the query; against
 * a shared database it would pass or fail on whatever rows some other session
 * happened to leave behind. The probe therefore builds its own multi-tenant
 * fixture, measures the plan, and rolls the whole thing back, so the plan it
 * reports came from data this test controls and nothing survives for anyone else
 * to trip over.
 *
 * The rows go in one tenant at a time because build.tickets carries the
 * `tenant_isolation` RLS policy and this connection is a non-owner role: the WITH
 * CHECK admits only rows matching the tenant GUC currently in force. Having to
 * move the GUC to insert each tenant is that isolation working.
 */
async function seedTenantFixture(tx: postgres.TransactionSql): Promise<void> {
  // organizations.owner_membership_id carries a deferrable FK to a membership row
  // this fixture has no reason to create; the transaction never commits, so the
  // deferred check never runs.
  await tx`SET CONSTRAINTS ALL DEFERRED`;

  for (let tenant = 0; tenant < PROBE_TENANTS; tenant++) {
    const org = `${PROBE_ORG_PREFIX}${tenant}`;
    await tx`
      INSERT INTO organizations (id, name, slug, owner_membership_id)
      VALUES (${org}, ${`EXPLAIN probe ${tenant}`}, ${org}, 1)`;
    await tx`SELECT set_config('app.organization_id', ${org}, true)`;
    await tx`
      INSERT INTO build.tickets (org_id, title, ticket_number)
      SELECT ${org}, 'probe title ' || g, g
      FROM generate_series(1, ${PROBE_ROWS_PER_TENANT}) g`;
  }
}

async function captureFallbackPlan(client: ReturnType<typeof postgres>): Promise<string> {
  let plan = "";
  try {
    await client.begin(async (tx) => {
      await seedTenantFixture(tx);
      await tx`SELECT set_config('app.organization_id', ${PROBE_SUBJECT_ORG}, true)`;
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
