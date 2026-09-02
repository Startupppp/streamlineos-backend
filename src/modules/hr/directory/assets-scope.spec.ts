import { resolveAssetsScope, ASSETS_PERMISSION } from "./assets-scope";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { DataScope } from "../../access/access.types";
import { isScopable } from "../../rbac/permissions";

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

function makeAccess(scopeMap: Map<string, DataScope> = new Map()) {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(scopeMap),
  };
}

describe("resolveAssetsScope", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns all when user is org owner", async () => {
    const access = makeAccess();
    const result = await resolveAssetsScope(
      access,
      makeUser({ isOrgOwner: true }),
    );
    expect(result).toBe("all");
    expect(access.resolveUserPermissions).not.toHaveBeenCalled();
  });

  /**
   * This spec used to assert the opposite — that a non-scopable key resolves
   * `all` without consulting the grants at all. `hr:assets:manage` carries no
   * `scopable: true` entry, so that branch was permanently live and every caller
   * of `GET /hr/asset-returns` (gated on `hr:assets:view`) read the whole
   * organization. The old expectation encoded the vulnerability.
   */
  it("does not admit everyone just because the key is not marked scopable", async () => {
    expect(isScopable(ASSETS_PERMISSION)).toBe(false);
    const access = makeAccess(new Map());
    const result = await resolveAssetsScope(access, makeUser());
    expect(result).toBe("none");
    expect(access.resolveUserPermissions).toHaveBeenCalledWith("org-1", "user-1");
  });

  it("returns all when scope map contains all for the permission", async () => {
    const scopeMap = new Map<string, DataScope>([[ASSETS_PERMISSION, "all"]]);
    const access = makeAccess(scopeMap);
    const result = await resolveAssetsScope(access, makeUser());
    expect(result).toBe("all");
  });

  it("returns own when scope map contains own for the permission", async () => {
    const scopeMap = new Map<string, DataScope>([[ASSETS_PERMISSION, "own"]]);
    const access = makeAccess(scopeMap);
    const result = await resolveAssetsScope(access, makeUser());
    expect(result).toBe("own");
  });

  it("returns none when permission is not present in the scope map", async () => {
    const access = makeAccess(new Map());
    const result = await resolveAssetsScope(access, makeUser());
    expect(result).toBe("none");
  });
});
