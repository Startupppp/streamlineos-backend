import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import { PgDialect } from "drizzle-orm/pg-core";

jest.mock("../../rbac/permissions", () => ({
  ...jest.requireActual("../../rbac/permissions"),
  isScopable: jest.fn(() => true),
}));

import { isScopable } from "../../rbac/permissions";
import {
  ATTENDANCE_PERMISSION,
  attendanceMemberScope,
  resolveAttendanceReadScope,
  resolveAttendanceScope,
} from "./attendance-scope";

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

describe("resolveAttendanceScope", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isScopable as jest.Mock).mockReturnValue(true);
  });


  it("resolves owner scope from the database instead of trusting token claims", async () => {
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(
      new Map<string, DataScope>([[ATTENDANCE_PERMISSION, "all"]]),
    );
    const result = await resolveAttendanceScope(mockAccess, makeUser({ isOrgOwner: true }));
    expect(result.rawScope("spec reads the resolved value")).toBe("all");
    expect(mockAccess.resolveUserPermissions).toHaveBeenCalledWith("o1", "u1");
  });

  it("fails closed when the permission catalog unexpectedly marks manage unscopable", async () => {
    (isScopable as jest.Mock).mockReturnValue(false);
    const result = await resolveAttendanceScope(mockAccess, makeUser());
    expect(result.denied).toBe(true);
    expect(mockAccess.resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("returns all when the resolved permission scope is all", async () => {
    const scopeMap = new Map<string, DataScope>([[ATTENDANCE_PERMISSION, "all"]]);
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(scopeMap);
    const result = await resolveAttendanceScope(mockAccess, makeUser());
    expect(result.rawScope("spec reads the resolved value")).toBe("all");
  });

  it("returns own when the resolved permission scope is own", async () => {
    const scopeMap = new Map<string, DataScope>([[ATTENDANCE_PERMISSION, "own"]]);
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(scopeMap);
    const result = await resolveAttendanceScope(mockAccess, makeUser());
    expect(result.rawScope("spec reads the resolved value")).toBe("own");
  });

  it("returns none when the permission is not in the resolved map", async () => {
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Map<string, DataScope>());
    const result = await resolveAttendanceScope(mockAccess, makeUser());
    expect(result.denied).toBe(true);
  });

  it("maps a view-only employee to self-service read scope", async () => {
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Map());
    const result = await resolveAttendanceReadScope(mockAccess, makeUser());
    expect(result.rawScope("spec reads the resolved value")).toBe("own");
  });

  it("binds own summary reads to the authenticated user", () => {
    const shape = attendanceMemberScope(7);
    if (!("own" in shape)) throw new Error("expected an own-shaped scope");
    const compiled = new PgDialect().sqlToQuery(shape.own);
    expect(compiled.params).toEqual([7]);
  });

  it("falls back to owner-only when no team members are resolved", () => {
    const shape = attendanceMemberScope(7);
    if (!("own" in shape)) throw new Error("expected an own-shaped scope");
    const compiled = new PgDialect().sqlToQuery(shape.team ?? shape.own);
    expect(compiled.params).toEqual([7]);
  });
});
