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
  TS_ENTRIES_VIEW_PERMISSION,
  TS_PAYROLL_VIEW_PERMISSION,
  TS_REPORTS_VIEW_PERMISSION,
  TS_TEAM_VIEW_PERMISSION,
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
  const scopes = (byKey: Record<string, "all" | "team" | "own" | "none">) =>
    (mockAccess.scopeFor as jest.Mock).mockImplementation(async (_: unknown, key: string) => byKey[key] ?? "none");

  it("returns none when neither the gate key nor the widening key is held", async () => {
    (mockAccess.scopeFor as jest.Mock).mockResolvedValue("none");
    const read = await resolveEntriesScope(mockAccess, makeUser());
    expect(read.denied).toBe(true);
  });

  it("gives a member who holds only entries:view their own rows, not nothing", async () => {
    scopes({ [TS_ENTRIES_VIEW_PERMISSION]: "own" });
    const read = await resolveEntriesScope(mockAccess, makeUser());
    expect(read.denied).toBe(false);
    expect(read.unrestricted).toBe(false);
    expect(mockAccess.scopeFor).toHaveBeenCalledWith(expect.anything(), TS_ENTRIES_VIEW_PERMISSION);
    expect(mockAccess.scopeFor).toHaveBeenCalledWith(expect.anything(), TS_TEAM_VIEW_PERMISSION);
  });

  it("widens to all through team:view without touching the gate key's own scope", async () => {
    scopes({ [TS_ENTRIES_VIEW_PERMISSION]: "own", [TS_TEAM_VIEW_PERMISSION]: "all" });
    const read = await resolveEntriesScope(mockAccess, makeUser());
    expect(read.unrestricted).toBe(true);
  });

  it("never narrows: a widening key at none leaves the gate key's own scope in place", async () => {
    scopes({ [TS_ENTRIES_VIEW_PERMISSION]: "all", [TS_TEAM_VIEW_PERMISSION]: "none" });
    const read = await resolveEntriesScope(mockAccess, makeUser());
    expect(read.unrestricted).toBe(true);
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
