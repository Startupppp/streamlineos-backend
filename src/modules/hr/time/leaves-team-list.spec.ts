import { ForbiddenException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { DataScope } from "../../access/access.types";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";

jest.mock("../../rbac/permissions", () => ({
  ...jest.requireActual("../../rbac/permissions"),
  isScopable: jest.fn(() => true),
}));

jest.mock("./organization-membership", () => ({
  requireOrganizationMembershipId: jest.fn().mockResolvedValue(41),
}));

import { LeavesService } from "./leaves.service";
import { LEAVES_PERMISSION } from "./leaves-scope";
import { listTeamLeaveRequestsSchema } from "./dto/leaves.schemas";
import { leavesTeamResponseSchema } from "./dto/time-leave-response.schemas";

const ACTOR_MEMBERSHIP_ID = 41;

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "u1",
    orgId: "o1",
    role: "EMPLOYEE",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...overrides,
  };
}

type FindManyArgs = {
  where?: unknown;
  with?: Record<string, { columns?: Record<string, boolean> }>;
  orderBy?: unknown[];
  limit?: number;
};

function build(scope: DataScope, rows: unknown[] = [], directReports: string[] = []) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const select = jest.fn(() => ({
    from: () => ({
      where: () => ({
        limit: jest.fn().mockResolvedValue(directReports.map((_, i) => ({ id: 900 + i }))),
      }),
    }),
  }));
  const db = { query: { leaveRequests: { findMany } }, select };
  const access = {
    resolveUserPermissions: jest
      .fn()
      .mockResolvedValue(new Map<string, DataScope>([[LEAVES_PERMISSION, scope]])),
  };
  const employment = { getDirectReportUserIds: jest.fn().mockResolvedValue(directReports) };
  const service = new LeavesService(
    db as never,
    {} as never,
    access as never,
    undefined as never,
    employment as never,
  );
  return { service, findMany, employment, access };
}

function lastFindManyArgs(findMany: jest.Mock): FindManyArgs {
  const args = findMany.mock.calls.at(-1)?.[0] as FindManyArgs | undefined;
  if (!args) throw new Error("findMany was not called");
  return args;
}

function compiledWhere(findMany: jest.Mock) {
  const { where } = lastFindManyArgs(findMany);
  if (!where) throw new Error("no where clause");
  return new PgDialect().sqlToQuery(where as never);
}

describe("listTeamLeaveRequestsSchema", () => {
  it("defaults to a bounded page and clamps an oversized limit to the platform cap", () => {
    expect(listTeamLeaveRequestsSchema.parse({}).limit).toBeLessThanOrEqual(PAGE_SIZE_CAP);
    expect(listTeamLeaveRequestsSchema.parse({ limit: "500" }).limit).toBe(PAGE_SIZE_CAP);
  });

  it("accepts cursor, status, leaveTypeId and an overlap date window", () => {
    const parsed = listTeamLeaveRequestsSchema.parse({
      cursor: "120",
      limit: "25",
      status: "APPROVED",
      leaveTypeId: "7",
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(parsed).toEqual({
      cursor: 120,
      limit: 25,
      status: "APPROVED",
      leaveTypeId: 7,
      from: "2026-01-01",
      to: "2026-01-31",
    });
  });

  it("rejects unknown keys, an unknown status and an inverted window", () => {
    expect(listTeamLeaveRequestsSchema.safeParse({ foo: "bar" }).success).toBe(false);
    expect(listTeamLeaveRequestsSchema.safeParse({ status: "DRAFT" }).success).toBe(false);
    expect(
      listTeamLeaveRequestsSchema.safeParse({ from: "2026-02-01", to: "2026-01-01" }).success,
    ).toBe(false);
    expect(listTeamLeaveRequestsSchema.safeParse({ from: "01/02/2026" }).success).toBe(false);
  });
});

describe("LeavesService.team", () => {
  beforeEach(() => jest.clearAllMocks());

  it("denies a caller with no leave approval scope", async () => {
    const { service, findMany } = build("none");
    await expect(service.team(makeUser(), { limit: 50 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("reads limit + 1 rows and returns a cursor envelope instead of a pending/all dump", async () => {
    const { service, findMany } = build("all", [{ id: 9 }, { id: 8 }, { id: 7 }]);

    const result = await service.team(makeUser(), { cursor: 10, limit: 2 });

    expect(lastFindManyArgs(findMany).limit).toBe(3);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      data: [{ id: 9 }, { id: 8 }],
      pageInfo: { limit: 2, hasMore: true, nextCursor: 8 },
    });
    expect(result).not.toHaveProperty("pending");
    expect(result).not.toHaveProperty("all");
  });

  it("ends the walk with a null cursor when the page is not full", async () => {
    const { service } = build("all", [{ id: 3 }]);
    const result = await service.team(makeUser(), { limit: 2 });
    expect(result.pageInfo).toEqual({ limit: 2, hasMore: false, nextCursor: null });
  });

  it("never reads more than the platform cap even when the caller bypasses DTO validation", async () => {
    const { service, findMany } = build("all");
    await service.team(makeUser(), { limit: 500 });
    expect(lastFindManyArgs(findMany).limit).toBe(PAGE_SIZE_CAP + 1);
  });

  it("keysets on id descending and binds the cursor", async () => {
    const { service, findMany } = build("all");
    await service.team(makeUser(), { cursor: 120, limit: 10 });

    const { sql, params } = compiledWhere(findMany);
    expect(sql).toContain('"id" < ');
    expect(params).toContain(120);
    const order = lastFindManyArgs(findMany).orderBy ?? [];
    expect(order).toHaveLength(1);
    expect(new PgDialect().sqlToQuery(order[0] as never).sql).toMatch(/"id" desc/i);
  });

  it("always re-asserts the tenant", async () => {
    const { service, findMany } = build("all");
    await service.team(makeUser(), { limit: 10 });
    const { sql, params } = compiledWhere(findMany);
    expect(sql).toContain('"org_id" = ');
    expect(params).toContain("o1");
  });

  it("applies the status filter in SQL", async () => {
    const { service, findMany } = build("all");
    await service.team(makeUser(), { limit: 10, status: "APPROVED" });
    const { sql, params } = compiledWhere(findMany);
    expect(sql).toContain('"status" = ');
    expect(params).toContain("APPROVED");
  });

  it("applies the leave type filter in SQL", async () => {
    const { service, findMany } = build("all");
    await service.team(makeUser(), { limit: 10, leaveTypeId: 7 });
    const { sql, params } = compiledWhere(findMany);
    expect(sql).toContain('"leave_type_id" = ');
    expect(params).toContain(7);
  });

  it("applies the date window as an overlap: start <= to and end >= from", async () => {
    const { service, findMany } = build("all");
    await service.team(makeUser(), { limit: 10, from: "2026-01-01", to: "2026-01-31" });
    const { sql, params } = compiledWhere(findMany);
    expect(sql).toContain('"start_date" <= ');
    expect(sql).toContain('"end_date" >= ');
    expect(params).toEqual(expect.arrayContaining(["2026-01-01", "2026-01-31"]));
  });

  it("adds no status or date predicate when no filter is given", async () => {
    const { service, findMany } = build("all");
    await service.team(makeUser(), { limit: 10 });
    const { sql } = compiledWhere(findMany);
    expect(sql).not.toContain('"status" = ');
    expect(sql).not.toContain('"start_date"');
    expect(sql).not.toContain('"leave_type_id"');
    expect(sql).not.toContain('"created_at"');
  });

  it("narrows the user projection to display fields only", async () => {
    const { service, findMany } = build("all");
    await service.team(makeUser(), { limit: 10 });
    const relations = lastFindManyArgs(findMany).with ?? {};
    expect(relations.user?.columns).toEqual({
      id: true,
      name: true,
      firstName: true,
      lastName: true,
      image: true,
    });
    expect(relations.user?.columns).not.toHaveProperty("email");
    expect(relations.user?.columns).not.toHaveProperty("designation");
    expect(relations.approver?.columns).toEqual({
      id: true,
      name: true,
      firstName: true,
      lastName: true,
    });
    expect(relations.leaveType?.columns).toEqual({ id: true, name: true });
    expect(Object.keys(relations).sort()).toEqual(["approver", "leaveType", "user"]);
  });

  it("binds an own-scoped caller to the server-assigned approver membership", async () => {
    const { service, findMany, employment } = build("own");
    await service.team(makeUser(), { limit: 10 });
    const { sql, params } = compiledWhere(findMany);
    expect(sql).toContain('"approver_membership_id" = ');
    expect(params).toContain(ACTOR_MEMBERSHIP_ID);
    expect(employment.getDirectReportUserIds).toHaveBeenCalledWith("o1", "u1");
  });

  it("does not consult direct reports or bind the actor for an unrestricted caller", async () => {
    const { service, findMany, employment } = build("all");
    await service.team(makeUser(), { limit: 10 });
    const { sql, params } = compiledWhere(findMany);
    expect(sql).not.toContain('"approver_membership_id"');
    expect(params).not.toContain(ACTOR_MEMBERSHIP_ID);
    expect(employment.getDirectReportUserIds).not.toHaveBeenCalled();
  });

  it("folds direct reports' pending requests into the same paginated query, never a second dump", async () => {
    const { service, findMany } = build("own", [], ["report-1", "report-2"]);
    await service.team(makeUser(), { limit: 10 });

    expect(findMany).toHaveBeenCalledTimes(1);
    const { sql, params } = compiledWhere(findMany);
    expect(sql).toContain('"approver_membership_id" = ');
    expect(sql).toContain('"user_membership_id" in ');
    expect(sql).toContain('"status" = ');
    expect(params).toEqual(expect.arrayContaining([ACTOR_MEMBERSHIP_ID, 900, 901, "PENDING"]));
  });
});

describe("leavesTeamResponseSchema", () => {
  it("is a cursor envelope", () => {
    const parsed = leavesTeamResponseSchema.safeParse({
      data: [],
      pageInfo: { limit: 50, hasMore: false, nextCursor: null },
    });
    expect(parsed.success).toBe(true);
    expect(leavesTeamResponseSchema.safeParse({ pending: [], all: [] }).success).toBe(false);
  });
});
