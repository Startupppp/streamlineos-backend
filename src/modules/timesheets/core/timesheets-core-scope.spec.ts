import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { AccessService } from "../../access/access.service";

jest.mock("../../rbac/permissions", () => ({
  ...jest.requireActual("../../rbac/permissions"),
  isScopable: jest.fn(() => true),
}));

import { isScopable } from "../../rbac/permissions";
import {
  resolveApprovalScope,
  resolveEntriesScope,
  resolvePayrollScope,
  resolveReportsScope,
  TS_PAYROLL_VIEW_PERMISSION,
  TS_REPORTS_VIEW_PERMISSION,
} from "./timesheets-core-scope";

const mockAccess = { resolveUserPermissions: jest.fn() } as unknown as AccessService;

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    role: "EMPLOYEE",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (isScopable as jest.Mock).mockReturnValue(true);
});

describe("resolveEntriesScope", () => {
  it("returns none when team permission is absent", async () => {
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Map());
    await expect(resolveEntriesScope(mockAccess, makeUser())).resolves.toBe("none");
  });

  it("returns none when permission is not scopable", async () => {
    (isScopable as jest.Mock).mockReturnValue(false);
    await expect(resolveEntriesScope(mockAccess, makeUser())).resolves.toBe("none");
  });
});

describe("resolveReportsScope", () => {
  it("returns none when reports permission is absent", async () => {
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Map());
    await expect(resolveReportsScope(mockAccess, makeUser())).resolves.toBe("none");
  });

  it("does not fall back to own when permission is missing", async () => {
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(
      new Map([[TS_REPORTS_VIEW_PERMISSION, "team"]]),
    );
    await expect(resolveReportsScope(mockAccess, makeUser())).resolves.toBe("team");
  });
});

describe("resolveApprovalScope", () => {
  it("returns none when permission is not scopable", async () => {
    (isScopable as jest.Mock).mockReturnValue(false);
    await expect(resolveApprovalScope(mockAccess, makeUser())).resolves.toBe("none");
  });

  it("returns none when approvals permission is absent", async () => {
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Map());
    await expect(resolveApprovalScope(mockAccess, makeUser())).resolves.toBe("none");
  });
});

describe("resolvePayrollScope", () => {
  it("returns none when payroll permission is absent", async () => {
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Map());
    await expect(resolvePayrollScope(mockAccess, makeUser())).resolves.toBe("none");
  });

  it("returns resolved scope when payroll permission is present", async () => {
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(
      new Map([[TS_PAYROLL_VIEW_PERMISSION, "team"]]),
    );
    await expect(resolvePayrollScope(mockAccess, makeUser())).resolves.toBe("team");
  });
});
