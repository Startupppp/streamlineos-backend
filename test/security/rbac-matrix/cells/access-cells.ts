import { RolesController } from "src/modules/rbac/roles.controller";
import type { ExecutableCell, ExpectedOutcome } from "../matrix.types";
import { probeHttp } from "../adapters/http-adapter";
import { moduleAccessManage, moduleStanding, roleMemberAdd } from "../adapters/service-adapter";
import { ORG_A, ORG_B, STANDINGS, membershipIdOf, roleIdOf, userOf, type Standing } from "../standings";
import type { WorldDb } from "../world-db";

const MANAGE_EXPECTED: Readonly<Record<Standing, ExpectedOutcome>> = {
  "org:owner": "allow",
  "org:admin": "allow",
  "module:owner": "allow",
  "module:admin": "allow",
  "org:member": "403",
  "module:member": "403",
  outsider: "403",
};

const MANAGE_PAIR: Partial<Record<Standing, string>> = {
  "org:member": "module-access-manage-org-admin",
  "module:member": "module-access-manage-module-admin",
  outsider: "module-access-manage-org-owner",
};

const MANAGE_REASON: Readonly<Record<Standing, string>> = {
  "org:owner": "the org owner is the break-glass over every module",
  "org:admin": "an active ORG_ADMIN membership row is structural module authority",
  "module:owner": "the module ownership row is module authority",
  "module:admin": "a live rank-20 module role assignment administers the module",
  "org:member": "holding no structural standing, a plain member cannot administer module access",
  "module:member": "a module member role is not the admin rung",
  outsider: "no live membership resolves no standing at all",
};

const ROLE_HTTP_EXPECTED: Readonly<Record<Standing, ExpectedOutcome>> = {
  "org:owner": "allow",
  "org:admin": "allow",
  "org:member": "403",
  "module:owner": "403",
  "module:admin": "403",
  "module:member": "403",
  outsider: "403",
};

const STANDING_GRANTORS: readonly Standing[] = ["org:owner", "org:admin", "module:owner", "module:admin"];
const STANDING_REFUSED: readonly Standing[] = ["org:member", "module:member", "outsider"];

function slug(standing: Standing): string {
  return standing.replace(":", "-");
}

export function accessCells(world: WorldDb): ExecutableCell[] {
  const memberTarget = membershipIdOf("module:member", ORG_A);
  const adminTarget = membershipIdOf("module:admin", ORG_A);
  const assignableRole = roleIdOf("BUILD_MODULE_MEMBER", ORG_A);
  const assignee = userOf("org:member", ORG_A);
  const cells: ExecutableCell[] = [];

  for (const standing of STANDINGS) {
    const expected = MANAGE_EXPECTED[standing];
    cells.push({
      kind: "executable",
      id: `module-access-manage-${slug(standing)}`,
      standing,
      resource: "module-access:build",
      action: "manage-access",
      tenant: "same",
      state: "normal",
      expected,
      adapter: "service",
      because: MANAGE_REASON[standing],
      pairedWith: MANAGE_PAIR[standing],
      run: () => moduleAccessManage(world, standing, ORG_A),
    });
  }

  for (const standing of STANDING_GRANTORS)
    cells.push({
      kind: "executable",
      id: `module-standing-grant-${slug(standing)}`,
      standing,
      resource: "module-access:standing",
      action: "grant-admin",
      tenant: "same",
      state: "normal",
      expected: "allow",
      adapter: "service",
      because: "a standing that administers the module may seat a module admin at or below its own rank",
      run: () => moduleStanding(world, "grant", standing, ORG_A, memberTarget),
    });

  for (const standing of STANDING_REFUSED)
    cells.push({
      kind: "executable",
      id: `module-standing-grant-${slug(standing)}`,
      standing,
      resource: "module-access:standing",
      action: "grant-admin",
      tenant: "same",
      state: "normal",
      expected: "403",
      adapter: "service",
      because: "a standing without module authority is refused before any role assignment is written",
      pairedWith: "module-standing-grant-module-admin",
      run: () => moduleStanding(world, "grant", standing, ORG_A, memberTarget),
    });

  cells.push(
    {
      kind: "executable",
      id: "module-standing-grant-cross-tenant",
      standing: "org:admin",
      resource: "module-access:standing",
      action: "grant-admin",
      tenant: "other",
      state: "normal",
      expected: "404",
      adapter: "service",
      because: "a membership id from another organisation is not found in the caller's tenant",
      pairedWith: "module-standing-grant-org-admin",
      run: () => moduleStanding(world, "grant", "org:admin", ORG_B, memberTarget),
    },
    {
      kind: "executable",
      id: "module-standing-revoke-org-admin",
      standing: "org:admin",
      resource: "module-access:standing",
      action: "revoke",
      tenant: "same",
      state: "normal",
      expected: "allow",
      adapter: "service",
      because: "an org admin may revoke a module admin's standing",
      run: () => moduleStanding(world, "revoke", "org:admin", ORG_A, adminTarget),
    },
    {
      kind: "executable",
      id: "module-standing-revoke-org-member",
      standing: "org:member",
      resource: "module-access:standing",
      action: "revoke",
      tenant: "same",
      state: "normal",
      expected: "403",
      adapter: "service",
      because: "a plain member cannot revoke anyone's module standing",
      pairedWith: "module-standing-revoke-org-admin",
      run: () => moduleStanding(world, "revoke", "org:member", ORG_A, adminTarget),
    },
    {
      kind: "executable",
      id: "module-standing-revoke-cross-tenant",
      standing: "org:admin",
      resource: "module-access:standing",
      action: "revoke",
      tenant: "other",
      state: "normal",
      expected: "404",
      adapter: "service",
      because: "revoking a membership id from another organisation answers not-found, never forbidden",
      pairedWith: "module-standing-revoke-org-admin",
      run: () => moduleStanding(world, "revoke", "org:admin", ORG_B, adminTarget),
    },
  );

  for (const standing of STANDINGS) {
    const expected = ROLE_HTTP_EXPECTED[standing];
    cells.push({
      kind: "executable",
      id: `rbac-role-member-http-${slug(standing)}`,
      standing,
      resource: "rbac:role-member",
      action: "assign",
      tenant: "same",
      state: "normal",
      expected,
      adapter: "http",
      because:
        expected === "allow"
          ? "org owners and org admins resolve settings:rbac:manage from the real permission resolver"
          : "module standings and plain members never resolve settings:rbac:manage, so PermissionGuard refuses",
      pairedWith: expected === "allow" ? undefined : "rbac-role-member-http-org-admin",
      run: () =>
        probeHttp(world, {
          controllers: [RolesController],
          verb: "post",
          path: `/roles/${assignableRole}/members`,
          body: { principalType: "user", principalId: assignee },
          permissionKey: "settings:rbac:manage",
          standing,
          orgId: ORG_A,
        }),
    });
  }

  cells.push(
    {
      kind: "executable",
      id: "rbac-role-member-remove-http-org-admin",
      standing: "org:admin",
      resource: "rbac:role-member",
      action: "unassign",
      tenant: "same",
      state: "normal",
      expected: "allow",
      adapter: "http",
      because: "an org admin holds settings:rbac:manage",
      run: () =>
        probeHttp(world, {
          controllers: [RolesController],
          verb: "delete",
          path: `/roles/${assignableRole}/members`,
          body: { principalType: "user", principalId: assignee },
          permissionKey: "settings:rbac:manage",
          standing: "org:admin",
          orgId: ORG_A,
        }),
    },
    {
      kind: "executable",
      id: "rbac-role-member-remove-http-org-member",
      standing: "org:member",
      resource: "rbac:role-member",
      action: "unassign",
      tenant: "same",
      state: "normal",
      expected: "403",
      adapter: "http",
      because: "a plain member does not hold settings:rbac:manage",
      pairedWith: "rbac-role-member-remove-http-org-admin",
      run: () =>
        probeHttp(world, {
          controllers: [RolesController],
          verb: "delete",
          path: `/roles/${assignableRole}/members`,
          body: { principalType: "user", principalId: assignee },
          permissionKey: "settings:rbac:manage",
          standing: "org:member",
          orgId: ORG_A,
        }),
    },
    {
      kind: "executable",
      id: "rbac-role-member-service-org-owner",
      standing: "org:owner",
      resource: "rbac:role-member",
      action: "assign",
      tenant: "same",
      state: "normal",
      expected: "allow",
      adapter: "service",
      because: "the owner assigns an in-tenant role to an active member",
      run: () => roleMemberAdd(world, "org:owner", ORG_A, assignableRole, assignee),
    },
    {
      kind: "executable",
      id: "rbac-role-member-service-org-admin",
      standing: "org:admin",
      resource: "rbac:role-member",
      action: "assign",
      tenant: "same",
      state: "normal",
      expected: "allow",
      adapter: "service",
      because: "an org admin may assign a module member role whose grants it holds",
      run: () => roleMemberAdd(world, "org:admin", ORG_A, assignableRole, assignee),
    },
    {
      kind: "executable",
      id: "rbac-role-member-service-org-member",
      standing: "org:member",
      resource: "rbac:role-member",
      action: "assign",
      tenant: "same",
      state: "normal",
      expected: "403",
      adapter: "service",
      because: "a plain member cannot grant keys it does not hold even past the route guard",
      pairedWith: "rbac-role-member-service-org-admin",
      run: () => roleMemberAdd(world, "org:member", ORG_A, assignableRole, userOf("module:member", ORG_A)),
    },
    {
      kind: "executable",
      id: "rbac-role-member-service-cross-tenant",
      standing: "org:owner",
      resource: "rbac:role-member",
      action: "assign",
      tenant: "other",
      state: "normal",
      expected: "404",
      adapter: "service",
      because: "a role id from another organisation is not found, so the probe is no existence oracle",
      pairedWith: "rbac-role-member-service-org-owner",
      run: () => roleMemberAdd(world, "org:owner", ORG_B, assignableRole, userOf("org:member", ORG_B)),
    },
  );

  return cells;
}
