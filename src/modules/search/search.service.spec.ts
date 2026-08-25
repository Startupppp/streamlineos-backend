import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { AccessResolver } from "../access/authorize";
import type { DataScope } from "../access/access.types";
import { moduleAvailabilityResolver } from "../../common/rbac/module-availability";
import { isCoreModuleKey } from "../access/entitlements.service";
import { resolveSearchAccess } from "./search.service";

const user: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "MEMBER",
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
      scopeFor: async (_user, key) => scopes.get(key) ?? "none",
      getModuleState: async (_orgId, moduleKey) =>
        moduleKey === "crm" ? true : false,
      buildModuleAvailabilityResolver: (getModuleMap) =>
        moduleAvailabilityResolver({
          isCoreModule: isCoreModuleKey,
          getModuleMap,
          getPlanLockedModules: async () => [],
        }),
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
      scopeFor: async () => "none",
      getModuleState: async () => false,
      buildModuleAvailabilityResolver: (getModuleMap) =>
        moduleAvailabilityResolver({
          isCoreModule: isCoreModuleKey,
          getModuleMap,
          getPlanLockedModules: async () => [],
        }),
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
