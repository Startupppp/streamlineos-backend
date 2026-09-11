import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import { PgDialect } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import { leaveRequests } from "../../../db/schema";

jest.mock("../../rbac/permissions", () => ({
  ...jest.requireActual("../../rbac/permissions"),
  isScopable: jest.fn(() => true),
}));

import { isScopable } from "../../rbac/permissions";
import {
  LEAVES_PERMISSION,
  leaveApprovalScope,
  resolveLeavesViewScope,
} from "./leaves-scope";

const mockAccess = {
  resolveUserPermissions: jest.fn(),
} as unknown as AccessService;

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

describe("resolveLeavesViewScope", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isScopable as jest.Mock).mockReturnValue(true);
  });


  it("does not trust a token owner claim and resolves current database access", async () => {
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(
      new Map<string, DataScope>([[LEAVES_PERMISSION, "all"]]),
    );
    const result = await resolveLeavesViewScope(mockAccess, makeUser({ isOrgOwner: true }));
    expect(result.rawScope("spec reads the resolved value")).toBe("all");
    expect(mockAccess.resolveUserPermissions).toHaveBeenCalledWith("o1", "u1");
  });

  it("fails closed when the permission catalog is unexpectedly not scopable", async () => {
    (isScopable as jest.Mock).mockReturnValue(false);
    const result = await resolveLeavesViewScope(mockAccess, makeUser());
    expect(result.denied).toBe(true);
    expect(mockAccess.resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("returns all when the resolved permission scope is all", async () => {
    const scopeMap = new Map<string, DataScope>([[LEAVES_PERMISSION, "all"]]);
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(scopeMap);
    const result = await resolveLeavesViewScope(mockAccess, makeUser());
    expect(result.rawScope("spec reads the resolved value")).toBe("all");
  });

  it("returns own when the resolved permission scope is own", async () => {
    const scopeMap = new Map<string, DataScope>([[LEAVES_PERMISSION, "own"]]);
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(scopeMap);
    const result = await resolveLeavesViewScope(mockAccess, makeUser());
    expect(result.rawScope("spec reads the resolved value")).toBe("own");
  });

  it("returns none when the permission is not in the resolved map", async () => {
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Map<string, DataScope>());
    const result = await resolveLeavesViewScope(mockAccess, makeUser());
    expect(result.denied).toBe(true);
  });

  it("binds own-scope decisions to the server-assigned approver", () => {
    const shape = leaveApprovalScope(7);
    if (!("own" in shape)) throw new Error("expected an own-shaped scope");
    const compiled = new PgDialect().sqlToQuery(shape.own);
    expect(compiled.params).toEqual([7]);
  });

  it("uses the approver_membership_id column, not the legacy approver_id", () => {
    const shape = leaveApprovalScope(7);
    if (!("own" in shape)) throw new Error("expected an own-shaped scope");
    const compiled = new PgDialect().sqlToQuery(shape.own);
    expect(compiled.sql).toContain('"approver_membership_id" = ');
    expect(compiled.params).toEqual([7]);
  });

  it("never additionally requires the approver to be the requester, which the self-approval guard would always deny", () => {
    const shape = leaveApprovalScope(7);
    if (!("own" in shape)) throw new Error("expected an own-shaped scope");
    const compiled = new PgDialect().sqlToQuery(shape.own);
    expect(compiled.sql).not.toContain('"user_membership_id"');
  });

  it("matches the predicate the pending-approvals roster lists, so a listed request is decidable", () => {
    const listed = new PgDialect().sqlToQuery(
      eq(leaveRequests.approverMembershipId, 7),
    );
    const shape = leaveApprovalScope(7);
    if (!("own" in shape)) throw new Error("expected an own-shaped scope");
    const decidable = new PgDialect().sqlToQuery(shape.own);
    expect(decidable.sql).toBe(listed.sql);
    expect(decidable.params).toEqual(listed.params);
  });

  it("falls closed to false when no approver membership is resolved", () => {
    const shape = leaveApprovalScope(null);
    if (!("own" in shape)) throw new Error("expected an own-shaped scope");
    expect(new PgDialect().sqlToQuery(shape.own).sql).toContain("false");
  });
});
