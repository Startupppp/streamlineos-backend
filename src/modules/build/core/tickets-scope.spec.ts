import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { AccessService } from "../../access/access.service";
import { resolveTicketsScope, TICKETS_PERMISSION as TICKETS_MANAGE_PERMISSION } from "./tickets-scope";

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
  principal: humanSessionPrincipal(1, false),
  ...overrides,
});

beforeEach(() => {
  jest.resetAllMocks();
});

describe("resolveTicketsScope", () => {


  it("returns all when isOrgOwner is true", async () => {
    (mockAccess.scopeFor as jest.Mock).mockResolvedValueOnce("all");
    const result = await resolveTicketsScope(mockAccess, makeUser({ isOrgOwner: true }));
    expect(result.rawScope("spec reads the resolved value")).toBe("all");
    expect(mockAccess.scopeFor).toHaveBeenCalledWith(expect.objectContaining({ isOrgOwner: true }), TICKETS_MANAGE_PERMISSION);
  });

  it("confirms the permission is scopable (non-scopable path would return all without a DB call)", async () => {
    const { isScopable } = jest.requireActual<typeof import("../../rbac/permissions")>(
      "../../rbac/permissions",
    );
    expect(isScopable(TICKETS_MANAGE_PERMISSION)).toBe(true);
  });

  it("returns all when the resolved scope is all", async () => {
    (mockAccess.scopeFor as jest.Mock).mockResolvedValueOnce("all");
    const result = await resolveTicketsScope(mockAccess, makeUser());
    expect(result.rawScope("spec reads the resolved value")).toBe("all");
    expect(result.denied).toBe(false);
  });

  it("returns own when the resolved scope is own", async () => {
    (mockAccess.scopeFor as jest.Mock).mockResolvedValueOnce("own");
    const result = await resolveTicketsScope(mockAccess, makeUser());
    expect(result.rawScope("spec reads the resolved value")).toBe("own");
    expect(result.denied).toBe(false);
  });

  it("returns none when the permission is absent from the resolved map", async () => {
    (mockAccess.scopeFor as jest.Mock).mockResolvedValueOnce("none");
    const result = await resolveTicketsScope(mockAccess, makeUser());
    expect(result.denied).toBe(true);
  });
});
