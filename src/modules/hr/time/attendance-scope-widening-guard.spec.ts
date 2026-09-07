import { ForbiddenException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import { applyScope } from "../../access/apply-scope";
import { attendance } from "../../../db/schema";

jest.mock("../../rbac/permissions", () => ({
  ...jest.requireActual("../../rbac/permissions"),
  isScopable: jest.fn(() => true),
}));

jest.mock("./attendance-scope", () => ({
  ...jest.requireActual("./attendance-scope"),
  resolveAttendanceScope: jest.fn(),
}));

jest.mock("./organization-membership", () => ({
  requireOrganizationMembershipId: jest.fn().mockResolvedValue(1),
}));

import { resolveAttendanceScope } from "./attendance-scope";
import { AttendanceReadService } from "./attendance-read.service";
import { AttendanceRegularizationService } from "./attendance-regularization.service";

const mockAccess = { resolveUserPermissions: jest.fn() } as unknown as AccessService;
const mockDb = {} as never;
const mockPolicy = {} as never;
const mockWorkflow = {} as never;
const mockPayrollInputs = {} as never;
const mockAudit = {} as never;

function makeUser(userId = "actor-1"): CurrentUserContext {
  return {
    userId,
    orgId: "org-1",
    role: "EMPLOYEE",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

describe("AttendanceReadService scope-widening guard", () => {
  let svc: AttendanceReadService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new AttendanceReadService(mockDb, mockAccess, mockPolicy);
  });

  it("monthly() blocks own-scope caller from reading another user", async () => {
    (resolveAttendanceScope as jest.Mock).mockResolvedValue("own" satisfies DataScope);
    const actor = makeUser("actor-1");
    await expect(svc.monthly(actor, "other-user", 2026, 7)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("heatmap() blocks own-scope caller from reading another user", async () => {
    (resolveAttendanceScope as jest.Mock).mockResolvedValue("own" satisfies DataScope);
    const actor = makeUser("actor-1");
    await expect(svc.heatmap(actor, "other-user", 2026)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("monthly() allows own-scope caller to read their own data", async () => {
    (resolveAttendanceScope as jest.Mock).mockResolvedValue("own" satisfies DataScope);
    const actor = makeUser("actor-1");
    const mockQuery = { findMany: jest.fn().mockResolvedValue([]) };
    (svc as unknown as Record<string, unknown>)["db"] = { query: { attendance: mockQuery } };
    const result = await svc.monthly(actor, "actor-1", 2026, 7);
    expect(result).toEqual([]);
  });
});

describe("AttendanceRegularizationService scope-widening guard", () => {
  let svc: AttendanceRegularizationService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new AttendanceRegularizationService(mockDb, mockWorkflow, mockAccess, mockPayrollInputs, mockAudit);
  });

  it("list() blocks own-scope caller from widening to another userId", async () => {
    (resolveAttendanceScope as jest.Mock).mockResolvedValue("own" satisfies DataScope);
    const actor = makeUser("actor-1");
    await expect(
      svc.list(actor, { userId: "other-user", limit: 20 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("list() blocks none-scope caller entirely even without userId filter", async () => {
    (resolveAttendanceScope as jest.Mock).mockResolvedValue("none" satisfies DataScope);
    const actor = makeUser("actor-1");
    await expect(
      svc.list(actor, { userId: "other-user", limit: 20 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("applyScope SQL predicate — own scope binds exactly the actor", () => {
  it("renders a single equality predicate containing only the actor userId", () => {
    const actorId = "actor-uuid-123";
    const predicate = applyScope("own", "org-1", actorId, {
      ownerColumn: attendance.userId,
    });
    const compiled = new PgDialect().sqlToQuery(predicate);
    expect(compiled.params).toEqual([actorId]);
    expect(compiled.params).toHaveLength(1);
  });

  it("does not bind any other user id when scope is own", () => {
    const actorId = "actor-uuid-123";
    const otherId = "other-uuid-456";
    const predicate = applyScope("own", "org-1", actorId, {
      ownerColumn: attendance.userId,
    });
    const compiled = new PgDialect().sqlToQuery(predicate);
    expect(compiled.params).not.toContain(otherId);
  });

  it("renders false SQL when scope is none — no rows can leak", () => {
    const predicate = applyScope("none", "org-1", "actor-1", {
      ownerColumn: attendance.userId,
    });
    const compiled = new PgDialect().sqlToQuery(predicate);
    expect(compiled.sql).toContain("false");
  });
});
