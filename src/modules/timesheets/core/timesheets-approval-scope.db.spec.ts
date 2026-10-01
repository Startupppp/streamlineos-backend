/**
 * The row-level half of the approval arm, which no unit test can reach.
 *
 * `periodInApprovalScope` (periods-read.service.ts:254) re-asks the approval queue's
 * predicate about one period id. Its unit coverage proves the two surfaces ISSUE the same
 * narrowing SQL; it cannot prove Postgres RETURNS the same rows, because the fake answers
 * the probe whatever the predicate says. So the list/detail-agreement invariant — every
 * period a list surface shows must open — has only ever been asserted on rendered SQL.
 *
 * Runs the real `TimesheetOverdueService` and `PeriodsReadService` against a live Postgres
 * as `streamline_app` (NOBYPASSRLS) with the tenant GUC set on the session (BE-76). As the
 * owner these predicates are answered from rows the app can never see; with no GUC
 * `app.current_org_id()` raises 42501. Either makes a false green.
 *
 * The AccessService double answers `scopeFor` only — the same shape, and the same
 * `as never`, that `periods-read-tenant-isolation.spec.ts:48` already uses. Nothing else on
 * the service is touched, so the double cannot invent a callee.
 *
 *   ALLOW_DESTRUCTIVE_DB_TESTS=1 TZ=Asia/Kolkata \
 *   APP_DATABASE_URL=postgresql://streamline_app@127.0.0.1:5432/<scratch> \
 *     pnpm test:db-specs --testPathPattern="timesheets-approval-scope.db"
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import type { DataScope } from "../../access/access.types";
import { ScopedRead } from "../../access/scoped-read";
import * as schema from "../../../db/schema";
import { timesheetPeriods } from "../../../db/schema";
import { PeriodsReadService } from "./periods-read.service";
import { TimesheetOverdueService } from "./overdue.service";
import {
  approvalQueueScope,
  TS_APPROVALS_VIEW_PERMISSION,
  TS_ENTRIES_VIEW_PERMISSION,
  TS_TEAM_VIEW_PERMISSION,
} from "./timesheets-core-scope";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { dbSpecSuite, dbSpecUrl } from "../../../test/db-spec-gate";

const describeDb = dbSpecSuite(["APP_DATABASE_URL"]);

const ORG_A = "orgA";
const MGR = { userId: "u_mgr", membershipId: 1 };
const REP1_PERIOD_SUBMITTED = 1; // rep1's, current_approver = MGR
const OTHER_PERIOD_SUBMITTED = 2; // unrelated member's, assigned to someone else
const REP2_PERIOD_NULL_APPROVER = 3; // second-level report's, no approver
const ORG_B_PERIOD = 4; // another tenant's
const REP1_PERIOD_OVERDUE = 7; // rep1's OPEN period, no approver
const MGR_OWN_OVERDUE = 8;
const OTHER_OVERDUE = 9;

/** Only `scopeFor` is consulted; see the header. */
function accessDouble(byKey: Readonly<Record<string, DataScope>>) {
  return {
    scopeFor: async (_actor: unknown, key: string): Promise<DataScope> => byKey[key] ?? "none",
  };
}

function actor(): CurrentUserContext {
  return {
    userId: MGR.userId,
    orgId: ORG_A,
    role: "ADMIN",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: { kind: "human-session", userId: MGR.userId, orgId: ORG_A, membershipId: MGR.membershipId, sessionId: "s1" },
  } as never;
}

/** HTTP status the route would answer, from the exception the service throws. */
async function statusOf(run: () => Promise<unknown>): Promise<number> {
  try {
    await run();
    return 200;
  } catch (error) {
    const status = (error as { getStatus?: () => number }).getStatus?.();
    if (typeof status !== "number") throw error;
    return status;
  }
}

describeDb("approval arm — real database, app role, tenant GUC", () => {
  // The GUC rides the startup packet, so every statement the services issue on this
  // handle carries it — `this.db` in the services is not a tenant transaction here.
  const client = postgres(dbSpecUrl("APP_DATABASE_URL"), {
    max: 1,
    prepare: false,
    onnotice: () => undefined,
    connection: { options: `-c app.organization_id=${ORG_A}` },
  });
  const db = drizzle(client, { schema });

  afterAll(async () => {
    await client.end({ timeout: 5 });
  });

  function periods(scopes: Readonly<Record<string, DataScope>>) {
    return new PeriodsReadService(db as never, accessDouble(scopes) as never);
  }
  function overdue(scopes: Readonly<Record<string, DataScope>>) {
    return new TimesheetOverdueService(db as never, accessDouble(scopes) as never);
  }

  const APPROVALS_OWN = { [TS_APPROVALS_VIEW_PERMISSION]: "own" } as const;
  const APPROVALS_TEAM = { [TS_APPROVALS_VIEW_PERMISSION]: "team" } as const;

  it("connects as a role RLS applies to, with no bypass", async () => {
    const rows = await client`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows[0]?.rolbypassrls).toBe(false);
    const [guc] = await client`SELECT current_setting('app.organization_id') AS org`;
    expect(guc?.org).toBe(ORG_A);
  });

  it("admits the assigned approver to a submitted period, with its entries — the positive case the denials below are measured against", async () => {
    const result = await periods(APPROVALS_OWN).getPeriod(actor(), REP1_PERIOD_SUBMITTED);
    expect(result.period.id).toBe(REP1_PERIOD_SUBMITTED);
    expect(Array.isArray(result.entries)).toBe(true);
  });

  it("refuses a same-org period assigned to a different approver with 403", async () => {
    expect(await statusOf(() => periods(APPROVALS_OWN).getPeriod(actor(), OTHER_PERIOD_SUBMITTED))).toBe(403);
  });

  it("refuses a period with a null approver that the caller does not own with 403", async () => {
    expect(await statusOf(() => periods(APPROVALS_OWN).getPeriod(actor(), REP2_PERIOD_NULL_APPROVER))).toBe(403);
  });

  it("answers 404, not 403, for a period id in another org (BE-91)", async () => {
    expect(await statusOf(() => periods(APPROVALS_OWN).getPeriod(actor(), ORG_B_PERIOD))).toBe(404);
  });

  it("returns, for the approval queue predicate, exactly the periods the detail read admits", async () => {
    // `approvalQueueScope` is what approvals.service.ts:177 passes; this re-asks it
    // directly rather than instantiating that service's six unrelated collaborators.
    const read = ScopedRead.of(ORG_A, MGR.userId, "own");
    const listed = await read.read(
      {
        tenant: timesheetPeriods.orgId,
        scope: approvalQueueScope(MGR.membershipId),
        and: [eq(timesheetPeriods.status, "SUBMITTED")],
      },
      async (where) =>
        (await db.select({ id: timesheetPeriods.id }).from(timesheetPeriods).where(where.sql)).map((r) => r.id),
      () => [] as number[],
    );
    expect(listed).toContain(REP1_PERIOD_SUBMITTED);
    expect(listed).not.toContain(ORG_B_PERIOD);
    const svc = periods(APPROVALS_OWN);
    for (const id of listed) {
      expect(await statusOf(() => svc.getPeriod(actor(), id))).toBe(200);
    }

    // `approvalQueueScope` declares no `team` arm, so ScopedRead falls back to `own`:
    // the queue is the same set at team scope and must still open row for row.
    const atTeam = await ScopedRead.of(ORG_A, MGR.userId, "team").read(
      {
        tenant: timesheetPeriods.orgId,
        scope: approvalQueueScope(MGR.membershipId),
        and: [eq(timesheetPeriods.status, "SUBMITTED")],
      },
      async (where) =>
        (await db.select({ id: timesheetPeriods.id }).from(timesheetPeriods).where(where.sql)).map((r) => r.id),
      () => [] as number[],
    );
    expect(atTeam).toEqual(listed);
    const teamSvc = periods(APPROVALS_TEAM);
    for (const id of atTeam) {
      expect(await statusOf(() => teamSvc.getPeriod(actor(), id))).toBe(200);
    }
  });

  it("lists a plain reporting manager only their own overdue period at own scope", async () => {
    const queue = await overdue(APPROVALS_OWN).listOverdue(actor(), { page: 1, limit: 50 } as never);
    const ids = queue.items.map((i) => i.periodId);
    expect(ids).toContain(MGR_OWN_OVERDUE);
    expect(ids).not.toContain(REP1_PERIOD_OVERDUE);
    expect(ids).not.toContain(OTHER_OVERDUE);
  });

  /**
   * The row-level agreement invariant, and the most important assertion in this file.
   *
   * The overdue queue narrows with `membershipTeamScope` while `periodInApprovalScope`
   * answers with `approvalQueueTeamScope`, which composes that same reporting-graph arm
   * with the approver equality. Before that composition landed (8fb45fd54) this body
   * failed against Postgres with period 7 at status 403: the list showed a direct
   * report's period and the detail refused it.
   *
   * A unit test cannot reach this. The rendered-SQL assertion on
   * `feat/timesheets-overdue-agree` proves both surfaces issue the same narrowing SQL;
   * only two real queries prove Postgres returns the same rows for both.
   */
  it("agrees between the overdue list and the detail read at team scope: every listed period opens", async () => {
    const queue = await overdue(APPROVALS_TEAM).listOverdue(actor(), { page: 1, limit: 50 } as never);
    const ids = queue.items.map((i) => i.periodId);
    expect(ids).toContain(MGR_OWN_OVERDUE);
    expect(ids).toContain(REP1_PERIOD_OVERDUE); // positive half: the team arm widened the list
    expect(ids).not.toContain(OTHER_OVERDUE);

    const svc = periods(APPROVALS_TEAM);
    const refused: { id: number; status: number }[] = [];
    for (const id of ids) {
      const status = await statusOf(() => svc.getPeriod(actor(), id));
      if (status !== 200) refused.push({ id, status });
    }
    expect(refused).toEqual([]);
  });

  it("drops a period from the list AND from the detail together once the reporting line expires", async () => {
    // Both sides must fall away together. A stale line that admits the detail while the
    // list hides it is the mirror image of the disagreement above.
    await client`
      UPDATE hr_reporting_lines SET effective_to = app.org_business_date(${ORG_A}) - 1
       WHERE org_id = ${ORG_A} AND id = 1`;
    try {
      const queue = await overdue(APPROVALS_TEAM).listOverdue(actor(), { page: 1, limit: 50 } as never);
      expect(queue.items.map((i) => i.periodId)).not.toContain(REP1_PERIOD_OVERDUE);
      expect(await statusOf(() => periods(APPROVALS_TEAM).getPeriod(actor(), REP1_PERIOD_OVERDUE))).toBe(403);
      // The caller's own period is still listed, so the line change narrowed rather than emptied.
      expect(queue.items.map((i) => i.periodId)).toContain(MGR_OWN_OVERDUE);
    } finally {
      await client`
        UPDATE hr_reporting_lines SET effective_to = 'infinity'::date
         WHERE org_id = ${ORG_A} AND id = 1`;
    }
  });

  it("still admits the assigned approver when the entries and team keys are absent entirely", async () => {
    const svc = periods({ [TS_APPROVALS_VIEW_PERMISSION]: "own", [TS_ENTRIES_VIEW_PERMISSION]: "none", [TS_TEAM_VIEW_PERMISSION]: "none" });
    const result = await svc.getPeriod(actor(), REP1_PERIOD_SUBMITTED);
    expect(result.period.id).toBe(REP1_PERIOD_SUBMITTED);
    void sql;
  });
});
