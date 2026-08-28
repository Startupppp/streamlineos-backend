import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { AccessService } from "../../access/access.service";
import * as permissionsConstants from "../../rbac/permissions";

jest.mock("../../rbac/permissions", () => ({
  isScopable: jest.fn(),
}));

import {
  resolveDocumentsManageScope,
  resolveDocumentsScope,
  resolvePerformanceScope,
} from "./performance-scope";

const mockAccess = { resolveUserPermissions: jest.fn() } as unknown as AccessService;

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    role: "HR",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("resolvePerformanceScope", () => {


  it("returns all when isOrgOwner is true", async () => {
    const result = await resolvePerformanceScope(mockAccess, makeUser({ isOrgOwner: true }));
    expect(result).toBe("all");
    expect(mockAccess.resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("returns none when the permission is not scopable", async () => {
    jest.spyOn(permissionsConstants, "isScopable").mockReturnValue(false);
    const result = await resolvePerformanceScope(mockAccess, makeUser());
    expect(result).toBe("none");
    expect(mockAccess.resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("returns all when scope map contains all for the permission key", async () => {
    jest.spyOn(permissionsConstants, "isScopable").mockReturnValue(true);
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(
      new Map([["hr:performance:manage", "all"]]),
    );
    const result = await resolvePerformanceScope(mockAccess, makeUser());
    expect(result).toBe("all");
  });

  it("returns own when scope map contains own for the permission key", async () => {
    jest.spyOn(permissionsConstants, "isScopable").mockReturnValue(true);
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(
      new Map([["hr:performance:manage", "own"]]),
    );
    const result = await resolvePerformanceScope(mockAccess, makeUser());
    expect(result).toBe("own");
  });

  it("returns none when the permission key is absent from the scope map", async () => {
    jest.spyOn(permissionsConstants, "isScopable").mockReturnValue(true);
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Map());
    const result = await resolvePerformanceScope(mockAccess, makeUser());
    expect(result).toBe("none");
  });
});

describe("resolveDocumentsScope", () => {


  it("returns all when isOrgOwner is true", async () => {
    const result = await resolveDocumentsScope(mockAccess, makeUser({ isOrgOwner: true }));
    expect(result).toBe("all");
    expect(mockAccess.resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("returns none when the permission is not scopable", async () => {
    jest.spyOn(permissionsConstants, "isScopable").mockReturnValue(false);
    const result = await resolveDocumentsScope(mockAccess, makeUser());
    expect(result).toBe("none");
    expect(mockAccess.resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("returns all when scope map contains all for the permission key", async () => {
    jest.spyOn(permissionsConstants, "isScopable").mockReturnValue(true);
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(
      new Map([["hr:documents:view", "all"]]),
    );
    const result = await resolveDocumentsScope(mockAccess, makeUser());
    expect(result).toBe("all");
  });

  it("returns own when scope map contains own for the permission key", async () => {
    jest.spyOn(permissionsConstants, "isScopable").mockReturnValue(true);
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(
      new Map([["hr:documents:view", "own"]]),
    );
    const result = await resolveDocumentsScope(mockAccess, makeUser());
    expect(result).toBe("own");
  });

  it("returns none when the permission key is absent from the scope map", async () => {
    jest.spyOn(permissionsConstants, "isScopable").mockReturnValue(true);
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Map());
    const result = await resolveDocumentsScope(mockAccess, makeUser());
    expect(result).toBe("none");
  });
});

describe("resolveDocumentsManageScope", () => {
  it("uses the manage permission rather than widening a view grant", async () => {
    jest.spyOn(permissionsConstants, "isScopable").mockReturnValue(true);
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(
      new Map([
        ["hr:documents:view", "all"],
        ["hr:documents:manage", "own"],
      ]),
    );

    await expect(resolveDocumentsManageScope(mockAccess, makeUser())).resolves.toBe("own");
  });
});
