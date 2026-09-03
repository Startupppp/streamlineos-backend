/**
 * Real-database proof that GET /build/:projectId/budget reports money that exists.
 *
 * THE DEFECT THIS PINS
 * `getBudget` costed billable hours at `project_members.hourly_rate_minor`.
 * Nothing in the repository ever writes that column — all six
 * `insert/update(projectMembers)` sites set only org/project/membership/role,
 * and `addMemberSchema` is `.strict()` with no rate field — so the column is
 * always its `DEFAULT 0` and `actualCost` was structurally `0` for every
 * project in every org. A project manager read "0 spent, full budget
 * remaining" next to hundreds of real billable hours.
 *
 * The money that does exist is `timesheets.bill_rate` (+ `timesheets.currency`),
 * stamped at period approval by `TimesheetsApprovalsService` from
 * `RateResolverService` — which itself already falls back to the project
 * member's rate. So the member rate reaches the budget *through* the stamped
 * entry; reading it a second time here would double-count it.
 *
 * WHY THIS NEEDS A REAL DATABASE
 * The whole computation is one grouped aggregate with FILTER clauses over
 * `numeric` columns, and the correctness claim is about exact minor-unit
 * arithmetic on `numeric(6,2) x numeric(10,2)`. A mocked builder returns
 * whatever row it was handed and would confirm a broken value.
 *
 * Opt-in, like the other database specs in this repo, so the default hermetic
 * run is unaffected:
 *
 *   DATABASE_URL=... BUILD_DB_TESTS=1 npx jest --runInBand \
 *     --testPathPattern="projects-budget-actual-cost.db"
 */
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import { ProjectsBudgetService } from "./projects-budget.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ENABLED = process.env.BUILD_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

type Sql = ReturnType<typeof postgres>;

interface Fixture {
  orgId: string;
  userId: string;
  membershipId: number;
  projectId: number;
  ticketId: number;
}

/** Planned budget: 250,000.00 INR = 25,000,000 minor units. */
const PLANNED_BUDGET_MINOR = 25_000_000;

function makeCtx(orgId: string, userId: string, membershipId: number): CurrentUserContext {
  return {
    userId,
    orgId,
    role: "OWNER",
    isOrgOwner: true,
    sessionId: `sess-${membershipId}`,
    tokenScopes: null,
    principal: { kind: "human-session", membershipId, isOrgOwner: true },
  };
}

async function buildService(db: Db): Promise<ProjectsBudgetService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProjectsBudgetService,
      { provide: DRIZZLE, useValue: db },
      {
        provide: AccessService,
        useValue: {
          resolveUserPermissions: (): Promise<Map<string, DataScope>> =>
            Promise.resolve(new Map<string, DataScope>([["build:manage", "all"]])),
        },
      },
    ],
  }).compile();
  return moduleRef.get(ProjectsBudgetService);
}

async function seed(sql: Sql, budgetCurrency: string | null): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const orgId = `bgt-${tag}`;
  const userId = `bgt-u-${tag}`;
  const workspaceId = `bgt-ws-${tag}`;

  return sql.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, name) VALUES (${userId}, ${`${userId}@example.test`}, 'Budget Fixture')`;
    // The owner FK is DEFERRABLE INITIALLY DEFERRED, so org and membership can
    // be inserted in either order inside one transaction.
    await tx`
      INSERT INTO organizations (id, name, slug, owner_membership_id, currency)
      VALUES (${orgId}, ${`Budget ${tag}`}, ${`budget-${tag}`}, 1, 'INR')
    `;
    const [member] = await tx<{ id: number }[]>`
      INSERT INTO organization_members (user_id, org_id, role, is_owner)
      VALUES (${userId}, ${orgId}, 'OWNER', true)
      RETURNING id
    `;
    await tx`UPDATE organizations SET owner_membership_id = ${member.id} WHERE id = ${orgId}`;

    await tx`
      INSERT INTO build.pm_workspaces (pm_workspace_id, org_id, name, slug, is_default)
      VALUES (${workspaceId}, ${orgId}, 'Default', 'default', true)
    `;
    const [project] = await tx<{ id: number }[]>`
      INSERT INTO build.projects
        (org_id, name, key, pm_workspace_id, budget_minor, budget_currency, manager_membership_id)
      VALUES
        (${orgId}, ${`Budget ${tag}`}, ${`BGT${tag.slice(0, 4).toUpperCase()}`}, ${workspaceId},
         ${PLANNED_BUDGET_MINOR}, ${budgetCurrency}, ${member.id})
      RETURNING id
    `;
    await tx`
      INSERT INTO build.project_members (org_id, project_id, membership_id, role)
      VALUES (${orgId}, ${project.id}, ${member.id}, 'OWNER')
    `;
    // build.tickets.status is a composite FK into the project's own status set.
    await tx`
      INSERT INTO build.project_statuses (org_id, project_id, name, "order", type)
      VALUES (${orgId}, ${project.id}, 'TODO', 0, 'unstarted')
    `;
    const [ticket] = await tx<{ id: number }[]>`
      INSERT INTO build.tickets (org_id, project_id, title, ticket_number, status)
      VALUES (${orgId}, ${project.id}, 'Budget fixture ticket', 1, 'TODO')
      RETURNING id
    `;

    return { orgId, userId, membershipId: member.id, projectId: project.id, ticketId: ticket.id };
  });
}

async function logEntry(
  sql: Sql,
  f: Fixture,
  entry: { hours: string; billRate: string | null; currency: string | null },
): Promise<void> {
  await sql`
    INSERT INTO timesheets
      (org_id, user_membership_id, ticket_id, project_id, date, hours, is_billable, bill_rate, currency)
    VALUES
      (${f.orgId}, ${f.membershipId}, ${f.ticketId}, ${f.projectId}, '2026-02-01',
       ${entry.hours}, true, ${entry.billRate}, ${entry.currency})
  `;
}

async function dropFixtures(sql: Sql, fixtures: Fixture[]): Promise<void> {
  if (fixtures.length === 0) return;
  // Everything hangs off the org by ON DELETE CASCADE; the org's own owner FK is
  // deferred, so the row it points at may disappear in the same transaction.
  // One transaction for all fixtures — a per-fixture round trip made teardown
  // slower than jest's default 5s hook budget.
  await sql.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx`DELETE FROM organizations WHERE id = ANY(${fixtures.map((f) => f.orgId)})`;
    await tx`DELETE FROM users WHERE id = ANY(${fixtures.map((f) => f.userId)})`;
  });
}

describeDb("project budget — actual cost comes from stamped timesheet rates", () => {
  let sql: Sql;
  let db: Db;
  let service: ProjectsBudgetService;
  const fixtures: Fixture[] = [];

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required for BUILD_DB_TESTS");
    sql = postgres(url, { max: 2, prepare: false });
    db = drizzle(sql, { schema });
    service = await buildService(db);
  });

  afterAll(async () => {
    await dropFixtures(sql, fixtures);
    await sql?.end({ timeout: 5 });
  }, 60_000);

  it("costs billable hours at the rate stamped on the entry, not at the never-written member rate", async () => {
    const f = await seed(sql, "INR");
    fixtures.push(f);
    // 200.00 h x 500.00 INR/h = 100,000.00 INR
    await logEntry(sql, f, { hours: "200.00", billRate: "500.00", currency: "INR" });
    // 140.00 h x 750.00 INR/h = 105,000.00 INR
    await logEntry(sql, f, { hours: "140.00", billRate: "750.00", currency: "INR" });
    // 40.00 h with no stamped rate — real hours whose cost is unknown.
    await logEntry(sql, f, { hours: "40.00", billRate: null, currency: null });

    const result = await service.getBudget(makeCtx(f.orgId, f.userId, f.membershipId), f.projectId);

    // major units throughout the wire shape; 100,000.00 + 105,000.00
    expect(result.actualCost).toBe(205_000);
    expect(result.plannedBudget).toBe(250_000);
    expect(result.remaining).toBe(45_000);
    expect(result.utilizationPct).toBe(82);
    expect(result.totalHours).toBe(380);
    expect(result.unratedHours).toBe(40);
    expect(result.currency).toBe("INR");
    expect(result.currencyMismatch).toBe(false);
    expect(result.memberBreakdown).toEqual([
      { userId: f.userId, hours: 380, cost: 205_000, unratedHours: 40 },
    ]);
  }, 60_000);

  it("a non-zero member rate does not move the total — the stamped entry is the single source of truth", async () => {
    const f = await seed(sql, "INR");
    fixtures.push(f);
    await logEntry(sql, f, { hours: "10.00", billRate: "500.00", currency: "INR" });
    // Populate the legacy per-member rate columns directly. If getBudget still
    // read them it would double-count this member's 10 hours.
    await sql`
      UPDATE build.project_members
         SET hourly_rate = 900, hourly_rate_minor = 90000, rate_currency = 'INR'
       WHERE org_id = ${f.orgId} AND project_id = ${f.projectId}
    `;

    const result = await service.getBudget(makeCtx(f.orgId, f.userId, f.membershipId), f.projectId);

    // 10.00 h x 500.00 INR/h = 5,000.00 INR — not 5,000 + 10x900.
    expect(result.actualCost).toBe(5_000);
  }, 60_000);

  it("hours with no stamped rate cost nothing and are reported, so an understated total cannot read as under budget", async () => {
    const f = await seed(sql, "INR");
    fixtures.push(f);
    await logEntry(sql, f, { hours: "340.00", billRate: null, currency: null });

    const result = await service.getBudget(makeCtx(f.orgId, f.userId, f.membershipId), f.projectId);

    expect(result.actualCost).toBe(0);
    expect(result.totalHours).toBe(340);
    expect(result.unratedHours).toBe(340);
    expect(result.memberBreakdown).toEqual([
      { userId: f.userId, hours: 340, cost: 0, unratedHours: 340 },
    ]);
  }, 60_000);

  it("refuses to fold a foreign-currency entry into the project's budget currency", async () => {
    const f = await seed(sql, "INR");
    fixtures.push(f);
    // 100.00 h x 600.00 INR/h = 60,000.00 INR
    await logEntry(sql, f, { hours: "100.00", billRate: "600.00", currency: "INR" });
    // 20.00 h x 100.00 USD/h — USD minor units must never be added to an INR total.
    await logEntry(sql, f, { hours: "20.00", billRate: "100.00", currency: "USD" });

    const result = await service.getBudget(makeCtx(f.orgId, f.userId, f.membershipId), f.projectId);

    expect(result.currency).toBe("INR");
    expect(result.actualCost).toBe(60_000);
    expect(result.currencyMismatch).toBe(true);
    expect(result.excludedCurrencyHours).toBe(20);
    expect(result.totalHours).toBe(120);
  }, 60_000);

  it("adopts the entries' currency when the project declares none, rather than reporting nothing", async () => {
    const f = await seed(sql, null);
    fixtures.push(f);
    // 50.00 h x 400.00 INR/h = 20,000.00 INR
    await logEntry(sql, f, { hours: "50.00", billRate: "400.00", currency: "INR" });

    const result = await service.getBudget(makeCtx(f.orgId, f.userId, f.membershipId), f.projectId);

    expect(result.currency).toBe("INR");
    expect(result.actualCost).toBe(20_000);
    expect(result.currencyMismatch).toBe(false);
  }, 60_000);
});
