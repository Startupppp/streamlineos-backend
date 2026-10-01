import { ForbiddenException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { EntriesReadService } from "./entries-read.service";
import { PeriodsReadService } from "./periods-read.service";
import { TeamService } from "./team.service";

const ORG = "org-1";
const MANAGER_USER = "user-manager";
const MANAGER_MEMBERSHIP = 11;
const REPORT_MEMBERSHIP = 22;
const STRANGER_MEMBERSHIP = 33;

const dialect = new PgDialect();

function manager(): CurrentUserContext {
  return {
    userId: MANAGER_USER,
    orgId: ORG,
    role: "EMPLOYEE",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(MANAGER_MEMBERSHIP, false),
  };
}

/**
 * One chain that answers every shape these services build — `.where(...)`
 * awaited directly, or followed by `orderBy`/`limit`. Each `select()` takes the
 * next queued row set, and every predicate handed to `where` is recorded so a
 * test can render it.
 */
function makeDb(rowSets: readonly unknown[][]) {
  const wheres: unknown[] = [];
  let call = 0;
  const select = jest.fn().mockImplementation(() => {
    const rows = rowSets[call] ?? [];
    call += 1;
    const node = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
    for (const key of ["from", "leftJoin", "innerJoin", "groupBy", "orderBy", "limit"]) {
      node[key] = jest.fn().mockImplementation(() => node);
    }
    node.where = jest.fn().mockImplementation((predicate: unknown) => {
      wheres.push(predicate);
      return node;
    });
    return node;
  });
  const db = {
    select,
    query: { timesheets: { findMany: jest.fn().mockResolvedValue([]) } },
  } as unknown as Db;
  return { db, wheres, rendered: (i: number) => dialect.sqlToQuery(wheres[i] as never) };
}

function access(scope: "all" | "team" | "own" | "none") {
  return { scopeFor: jest.fn().mockResolvedValue(scope), holds: jest.fn().mockResolvedValue(true) } as never;
}

describe("timesheets team scope — per surface", () => {
  it("entries list: a team-scoped actor filters on own rows OR a current direct report's rows", async () => {
    const { db, rendered } = makeDb([[]]);
    const svc = new EntriesReadService(db, access("team"));

    await svc.listEntries(manager(), { limit: 50 } as never);

    const { sql, params } = rendered(0);
    expect(sql).toMatch(/"user_membership_id" = \$\d+ or exists/i);
    expect(sql).toContain("rm.id = \"timesheets\".\"user_membership_id\"");
    expect(params).toContain(MANAGER_USER);
    expect(params).toContain(MANAGER_MEMBERSHIP);
  });

  it("entries list: an own-scoped actor keeps the bare owner equality with no reporting-graph join", async () => {
    const { db, rendered } = makeDb([[]]);
    const svc = new EntriesReadService(db, access("own"));

    await svc.listEntries(manager(), { limit: 50 } as never);

    const { sql } = rendered(0);
    expect(sql).toContain("\"user_membership_id\" = $2");
    expect(sql).not.toContain("hr_reporting_lines");
  });

  it("team week summary: the member list itself is scoped to own plus direct reports", async () => {
    const { db, rendered } = makeDb([[]]);
    const svc = new TeamService(db, access("team"));

    await svc.getWeekSummary(manager(), { weekStart: "2026-01-05" } as never);

    const { sql, params } = rendered(0);
    expect(sql).toContain("\"organization_members\" rm");
    expect(sql).toContain("rm.id = \"organization_members\".\"id\"");
    expect(params).toContain(MANAGER_USER);
  });
});

describe("PeriodsReadService.getPeriod — team scope authorization", () => {
  const periodRow = (userMembershipId: number) => ({
    id: 7,
    orgId: ORG,
    userMembershipId,
    periodStart: "2026-01-05",
    periodEnd: "2026-01-11",
    status: "OPEN",
    totalHours: "0",
    billableHours: "0",
    nonBillableHours: "0",
    submittedAt: null,
    approvedAt: null,
    rejectedAt: null,
    lockedAt: null,
    currentApproverMembershipId: null,
    approvalRoute: null,
    approvalDueAt: null,
    approvalEscalatedAt: null,
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    userEmail: null,
    userName: null,
  });

  it("lets a team-scoped manager open a direct report's period", async () => {
    // Second select is the scope probe; a row back means the team predicate matched.
    const { db, rendered } = makeDb([[periodRow(REPORT_MEMBERSHIP)], [{ id: 7 }]]);
    const svc = new PeriodsReadService(db, access("team"));

    const result = await svc.getPeriod(manager(), 7);

    expect(result.period.id).toBe(7);
    const probe = rendered(1);
    expect(probe.sql).toMatch(/"user_membership_id" = \$\d+ or exists/i);
    expect(probe.params).toContain(MANAGER_USER);
  });

  it("still refuses a team-scoped manager an unrelated member's period", async () => {
    const { db } = makeDb([[periodRow(STRANGER_MEMBERSHIP)], []]);
    const svc = new PeriodsReadService(db, access("team"));

    await expect(svc.getPeriod(manager(), 7)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("answers own scope without a probe query, and still refuses another member's period", async () => {
    const { db, wheres } = makeDb([[periodRow(STRANGER_MEMBERSHIP)]]);
    const svc = new PeriodsReadService(db, access("own"));

    await expect(svc.getPeriod(manager(), 7)).rejects.toBeInstanceOf(ForbiddenException);
    expect(wheres).toHaveLength(1);
  });

  it("lets any scope open the actor's own period without a probe query", async () => {
    const { db, wheres } = makeDb([[periodRow(MANAGER_MEMBERSHIP)]]);
    const svc = new PeriodsReadService(db, access("team"));

    const result = await svc.getPeriod(manager(), 7);

    expect(result.period.userMembershipId).toBe(MANAGER_MEMBERSHIP);
    expect(wheres).toHaveLength(1);
  });
});
