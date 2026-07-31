import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import { resolveTimesheetsScope, TIMESHEETS_MANAGE_PERMISSION } from "./timesheets-scope";

const mockAccess = {
  resolveUserPermissions: jest.fn(),
} as unknown as AccessService;

const makeUser = (overrides: Partial<CurrentUserContext> = {}): CurrentUserContext => ({
  userId: "user-1",
  orgId: "org-1",
  branchId: null,
  role: "EMPLOYEE",
  permissions: [],
  enabledModules: [],
  plan: null,
  isOrgOwner: false,
  sessionId: "session-1",
  ...overrides,
});

beforeEach(() => {
  jest.resetAllMocks();
});

describe("resolveTimesheetsScope", () => {


  it("returns all when isOrgOwner is true", async () => {
    const result = await resolveTimesheetsScope(mockAccess, makeUser({ isOrgOwner: true }));
    expect(result).toBe("all");
    expect(mockAccess.resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("returns all when the permission is not scopable", async () => {
    const { isScopable } = jest.requireActual<typeof import("../rbac/permissions")>(
      "../rbac/permissions",
    );
    expect(isScopable(TIMESHEETS_MANAGE_PERMISSION)).toBe(true);
  });

  it("returns all when the resolved scope is all", async () => {
    const map = new Map<string, DataScope>([[TIMESHEETS_MANAGE_PERMISSION, "all"]]);
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValueOnce(map);
    const result = await resolveTimesheetsScope(mockAccess, makeUser());
    expect(result).toBe("all");
  });

  it("returns own when the resolved scope is own", async () => {
    const map = new Map<string, DataScope>([[TIMESHEETS_MANAGE_PERMISSION, "own"]]);
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValueOnce(map);
    const result = await resolveTimesheetsScope(mockAccess, makeUser());
    expect(result).toBe("own");
  });

  it("returns none when the permission is absent from the resolved map", async () => {
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValueOnce(new Map());
    const result = await resolveTimesheetsScope(mockAccess, makeUser());
    expect(result).toBe("none");
  });
});
