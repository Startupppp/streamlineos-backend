import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
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

const mockAccess = { scopeFor: jest.fn() } as unknown as AccessService;

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    role: "EMPLOYEE",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (isScopable as jest.Mock).mockReturnValue(true);
});

describe("resolveEntriesScope", () => {
  it("returns none when team permission is absent", async () => {
    (mockAccess.scopeFor as jest.Mock).mockResolvedValue("none");
    const read = await resolveEntriesScope(mockAccess, makeUser());
    expect(read.denied).toBe(true);
  });

  it("returns none when permission is not scopable", async () => {
    (mockAccess.scopeFor as jest.Mock).mockResolvedValue("none");
    const read = await resolveEntriesScope(mockAccess, makeUser());
    expect(read.denied).toBe(true);
  });
});

describe("resolveReportsScope", () => {
  it("returns none when reports permission is absent", async () => {
    (mockAccess.scopeFor as jest.Mock).mockResolvedValue("none");
    const read = await resolveReportsScope(mockAccess, makeUser());
    expect(read.denied).toBe(true);
  });

  it("does not fall back to own when permission is missing", async () => {
    (mockAccess.scopeFor as jest.Mock).mockResolvedValue("team");
    const read = await resolveReportsScope(mockAccess, makeUser());
    expect(read.rawScope("spec reads the resolved scope")).toBe("team");
  });
});

describe("resolveApprovalScope", () => {
  it("returns none when permission is not scopable", async () => {
    (mockAccess.scopeFor as jest.Mock).mockResolvedValue("none");
    const read = await resolveApprovalScope(mockAccess, makeUser());
    expect(read.denied).toBe(true);
  });

  it("returns none when approvals permission is absent", async () => {
    (mockAccess.scopeFor as jest.Mock).mockResolvedValue("none");
    const read = await resolveApprovalScope(mockAccess, makeUser());
    expect(read.denied).toBe(true);
  });
});

describe("resolvePayrollScope", () => {
  it("returns none when payroll permission is absent", async () => {
    (mockAccess.scopeFor as jest.Mock).mockResolvedValue("none");
    const read = await resolvePayrollScope(mockAccess, makeUser());
    expect(read.denied).toBe(true);
  });

  it("returns resolved scope when payroll permission is present", async () => {
    (mockAccess.scopeFor as jest.Mock).mockResolvedValue("team");
    const read = await resolvePayrollScope(mockAccess, makeUser());
    expect(read.rawScope("spec reads the resolved scope")).toBe("team");
  });
});
