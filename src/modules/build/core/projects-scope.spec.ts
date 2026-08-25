import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { AccessService } from "../../access/access.service";
import { resolveProjectsScope, PROJECTS_MANAGE_PERMISSION } from "./projects-scope";

const mockAccess = {
  scopeFor: jest.fn(),
} as unknown as AccessService;

const makeUser = (overrides: Partial<CurrentUserContext> = {}): CurrentUserContext => ({
  userId: "user-1",
  orgId: "org-1",
  role: "EMPLOYEE",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  ...overrides,
});

beforeEach(() => {
  jest.resetAllMocks();
});

describe("resolveProjectsScope", () => {


  it("returns all when isOrgOwner is true", async () => {
    (mockAccess.scopeFor as jest.Mock).mockResolvedValueOnce("all");
    const result = await resolveProjectsScope(mockAccess, makeUser({ isOrgOwner: true }));
    expect(result).toBe("all");
    expect(mockAccess.scopeFor).toHaveBeenCalledWith(expect.objectContaining({ isOrgOwner: true }), PROJECTS_MANAGE_PERMISSION);
  });

  it("confirms the permission is scopable (non-scopable path would return all without a DB call)", async () => {
    const { isScopable } = jest.requireActual<typeof import("../../rbac/permissions")>(
      "../../rbac/permissions",
    );
    expect(isScopable(PROJECTS_MANAGE_PERMISSION)).toBe(true);
  });

  it("returns all when the resolved scope is all", async () => {
    (mockAccess.scopeFor as jest.Mock).mockResolvedValueOnce("all");
    const result = await resolveProjectsScope(mockAccess, makeUser());
    expect(result).toBe("all");
  });

  it("returns own when the resolved scope is own", async () => {
    (mockAccess.scopeFor as jest.Mock).mockResolvedValueOnce("own");
    const result = await resolveProjectsScope(mockAccess, makeUser());
    expect(result).toBe("own");
  });

  it("returns none when the permission is absent from the resolved map", async () => {
    (mockAccess.scopeFor as jest.Mock).mockResolvedValueOnce("none");
    const result = await resolveProjectsScope(mockAccess, makeUser());
    expect(result).toBe("none");
  });
});
