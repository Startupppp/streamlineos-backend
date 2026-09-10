import { resolveReimbursementsScope } from "./reimbursements-scope";
import { HR_PAYROLL_LIST_PERMISSION } from "./hr-payroll-permissions";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import * as permissionsConstants from "../../rbac/permissions";

jest.mock("../../rbac/permissions", () => ({
  isScopable: jest.fn(),
}));

const mockIsScopable = permissionsConstants.isScopable as jest.MockedFunction<
  typeof permissionsConstants.isScopable
>;

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    role: "HR",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
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
    expect(result.rawScope("spec reads the resolved scope")).toBe("all");
    expect(access.resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("returns all when permission is not scopable", async () => {
    mockIsScopable.mockReturnValue(false);
    const access = makeAccess();
    const result = await resolveReimbursementsScope(access, makeUser());
    expect(mockIsScopable).toHaveBeenCalledWith(HR_PAYROLL_LIST_PERMISSION);
    expect(result.rawScope("spec reads the resolved scope")).toBe("all");
    expect(access.resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("returns all when scope map contains all for the permission", async () => {
    mockIsScopable.mockReturnValue(true);
    const scopeMap = new Map<string, DataScope>([[HR_PAYROLL_LIST_PERMISSION, "all"]]);
    const access = makeAccess(scopeMap);
    const result = await resolveReimbursementsScope(access, makeUser());
    expect(result.rawScope("spec reads the resolved scope")).toBe("all");
  });

  it("returns own when scope map contains own for the permission", async () => {
    mockIsScopable.mockReturnValue(true);
    const scopeMap = new Map<string, DataScope>([[HR_PAYROLL_LIST_PERMISSION, "own"]]);
    const access = makeAccess(scopeMap);
    const result = await resolveReimbursementsScope(access, makeUser());
    expect(result.rawScope("spec reads the resolved scope")).toBe("own");
  });

  it("returns none when permission is not present in the scope map", async () => {
    mockIsScopable.mockReturnValue(true);
    const access = makeAccess(new Map());
    const result = await resolveReimbursementsScope(access, makeUser());
    expect(result.denied).toBe(true);
  });
});
