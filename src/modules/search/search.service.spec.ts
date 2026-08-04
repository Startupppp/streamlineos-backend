import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { AccessResolver } from "../access/authorize";
import type { DataScope } from "../access/access.types";
import { resolveSearchAccess } from "./search.service";

const user: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "MEMBER",
  permissions: [],
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
};

describe("resolveSearchAccess", () => {
  it("returns only permitted domain scopes", async () => {
    const scopes = new Map<string, DataScope>([
      ["crm:leads:view", "own"],
      ["crm:contacts:view", "team"],
      ["build:tickets:view", "all"],
    ]);
    const access: AccessResolver = {
      resolveUserPermissions: async () => scopes,
      isModuleEnabled: async (_orgId, moduleKey) => moduleKey === "crm",
    };

    await expect(resolveSearchAccess(access, user)).resolves.toEqual({
      leads: "own",
      deals: null,
      contacts: "team",
      clients: null,
      build: null,
    });
  });

  it("does not expose disabled modules to an org owner", async () => {
    const access: AccessResolver = {
      resolveUserPermissions: async () => new Map(),
      isModuleEnabled: async () => false,
    };

    await expect(resolveSearchAccess(access, { ...user, isOrgOwner: true })).resolves.toEqual({
      leads: null,
      deals: null,
      contacts: null,
      clients: null,
      build: null,
    });
  });
});
