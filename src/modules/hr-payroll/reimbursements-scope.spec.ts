import {
  resolveReimbursementsScope,
  REIMBURSEMENTS_PERMISSION,
} from "./reimbursements-scope";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import * as permissionsConstants from "../rbac/permissions";

jest.mock("../rbac/permissions", () => ({
  isScopable: jest.fn(),
}));

const mockIsScopable = permissionsConstants.isScopable as jest.MockedFunction<
  typeof permissionsConstants.isScopable
>;

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    branchId: null,
    role: "HR",
    permissions: [],
    enabledModules: [],
    plan: null,
    isOrgOwner: false,
    sessionId: "session-1",
    ...overrides,
  };
}

function makeAccess(scopeMap: Map<string, DataScope> = new Map()): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(scopeMap),
  } as unknown as AccessService;
}

describe("resolveReimbursementsScope", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });


  it("returns all when user is org owner", async () => {
    const access = makeAccess();
    const result = await resolveReimbursementsScope(
      access,
      makeUser({ isOrgOwner: true }),
    );
    expect(result).toBe("all");
    expect(access.resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("returns all when permission is not scopable", async () => {
    mockIsScopable.mockReturnValue(false);
    const access = makeAccess();
    const result = await resolveReimbursementsScope(access, makeUser());
    expect(mockIsScopable).toHaveBeenCalledWith(REIMBURSEMENTS_PERMISSION);
    expect(result).toBe("all");
    expect(access.resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("returns all when scope map contains all for the permission", async () => {
    mockIsScopable.mockReturnValue(true);
    const scopeMap = new Map<string, DataScope>([[REIMBURSEMENTS_PERMISSION, "all"]]);
    const access = makeAccess(scopeMap);
    const result = await resolveReimbursementsScope(access, makeUser());
    expect(result).toBe("all");
  });

  it("returns own when scope map contains own for the permission", async () => {
    mockIsScopable.mockReturnValue(true);
    const scopeMap = new Map<string, DataScope>([[REIMBURSEMENTS_PERMISSION, "own"]]);
    const access = makeAccess(scopeMap);
    const result = await resolveReimbursementsScope(access, makeUser());
    expect(result).toBe("own");
  });

  it("returns none when permission is not present in the scope map", async () => {
    mockIsScopable.mockReturnValue(true);
    const access = makeAccess(new Map());
    const result = await resolveReimbursementsScope(access, makeUser());
    expect(result).toBe("none");
  });
});
