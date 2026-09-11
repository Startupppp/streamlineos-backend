import type { DataScope } from "../access/access.types";
import { humanSessionPrincipal } from "../../common/auth/principal";
import { CRM_PERMISSIONS } from "../rbac/permissions/crm";
import {
  ISSUES_VIEW_PERMISSION,
  resolveIssuesViewScope,
  type PermissionScopeReader,
} from "./issue-view-scope";

const reader = (scopes: Record<string, DataScope>): PermissionScopeReader => ({
  resolveUserPermissions: async () => new Map(Object.entries(scopes)),
});

const caller = (overrides: { isOrgOwner?: boolean } = {}) => ({
  userId: "user_1",
  orgId: "org_1",
  role: "MEMBER",
  permissions: [ISSUES_VIEW_PERMISSION],
  isOrgOwner: overrides.isOrgOwner ?? false,
  sessionId: "sess_1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, overrides.isOrgOwner ?? false),
});

describe("how much of the three record types a caller sees", () => {
  it("gives an org owner everything without a lookup", async () => {
    const never: PermissionScopeReader = {
      resolveUserPermissions: async () => {
        throw new Error("should not be consulted");
      },
    };
    const read = await resolveIssuesViewScope(never, caller({ isOrgOwner: true }));
    expect(read.rawScope("spec reads the resolved value")).toBe("all");
  });

  it("honours the scope the resolver returns", async () => {
    for (const scope of ["own", "team"] as const) {
      const read = await resolveIssuesViewScope(reader({ [ISSUES_VIEW_PERMISSION]: scope }), caller());
      expect(read.rawScope("spec reads the resolved value")).toBe(scope);
      expect(read.denied).toBe(false);
    }
  });

  /**
   * Fails closed. A caller whose grant the resolver could not find is a question
   * about authority, and defaulting that to `all` is how one missing row becomes
   * an organisation-wide read of every complaint.
   */
  it("returns none when the resolver knows nothing about the key", async () => {
    const read = await resolveIssuesViewScope(reader({}), caller());
    expect(read.denied).toBe(true);
    expect(read.rawScope("spec reads the resolved value")).toBe("none");
  });

  /**
   * The guard that matters most, because its failure is silent. `isScopable`
   * short-circuits to `all` for a key the catalogue does not mark scopable — so
   * dropping `scopable: true` from `crm:issues:view` would widen every restricted
   * member to the whole organisation with nothing else failing.
   */
  it("keeps the view key scopable in the catalogue", () => {
    const key = CRM_PERMISSIONS.find((permission) => permission.name === ISSUES_VIEW_PERMISSION);
    expect(key?.scopable).toBe(true);
  });
});
