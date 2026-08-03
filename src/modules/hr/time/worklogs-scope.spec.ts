import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";

jest.mock("../../rbac/permissions", () => ({
  ...jest.requireActual("../../rbac/permissions"),
  isScopable: jest.fn(() => true),
}));

import { isScopable } from "../../rbac/permissions";
import { WORKLOGS_PERMISSION, resolveWorkLogsScope } from "./worklogs-scope";

const mockAccess = {
  resolveUserPermissions: jest.fn(),
} as unknown as AccessService;

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "u1",
    orgId: "o1",
    role: "EMPLOYEE",
    permissions: [],
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    ...overrides,
  };
}

describe("resolveWorkLogsScope", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isScopable as jest.Mock).mockReturnValue(true);
  });


  it("returns all when isOrgOwner is true", async () => {
    const result = await resolveWorkLogsScope(mockAccess, makeUser({ isOrgOwner: true }));
    expect(result).toBe("all");
    expect(mockAccess.resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("returns all when the permission is not scopable", async () => {
    (isScopable as jest.Mock).mockReturnValue(false);
    const result = await resolveWorkLogsScope(mockAccess, makeUser());
    expect(result).toBe("all");
    expect(mockAccess.resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("returns all when the resolved permission scope is all", async () => {
    const scopeMap = new Map<string, DataScope>([[WORKLOGS_PERMISSION, "all"]]);
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(scopeMap);
    const result = await resolveWorkLogsScope(mockAccess, makeUser());
    expect(result).toBe("all");
  });

  it("returns own when the resolved permission scope is own", async () => {
    const scopeMap = new Map<string, DataScope>([[WORKLOGS_PERMISSION, "own"]]);
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(scopeMap);
    const result = await resolveWorkLogsScope(mockAccess, makeUser());
    expect(result).toBe("own");
  });

  it("returns none when the permission is not in the resolved map", async () => {
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Map<string, DataScope>());
    const result = await resolveWorkLogsScope(mockAccess, makeUser());
    expect(result).toBe("none");
  });
});
