import { RolesController } from "src/modules/rbac/roles.controller";
import { RolesService } from "src/modules/rbac/roles.service";
import type { AdapterBinding, ExpectedOutcome, Scenario } from "../matrix.types";
import { probeHttp } from "../adapters/http-adapter";
import { moduleAccessManage, moduleStanding, roleMemberAdd } from "../adapters/service-adapter";
import { rolesService } from "../adapters/real-services";
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

const MANAGE_REASON: Readonly<Record<Standing, string>> = {
  "org:owner": "the org owner is the break-glass over every module",
  "org:admin": "an active ORG_ADMIN membership row is structural module authority",
  "module:owner": "the module ownership row is module authority",
  "module:admin": "a live rank-20 module role assignment administers the module",
  "org:member": "holding no structural standing, a plain member cannot administer module access",
  "module:member": "a module member role is not the admin rung",
  outsider: "no live membership resolves no standing at all",
};

const ROLE_EXPECTED: Readonly<Record<Standing, ExpectedOutcome>> = {
  "org:owner": "allow",
  "org:admin": "allow",
  "org:member": "403",
  "module:owner": "403",
  "module:admin": "403",
  "module:member": "403",
  outsider: "403",
};

const GRANTORS: readonly Standing[] = ["org:owner", "org:admin", "module:owner", "module:admin"];
const MODULE_AUTHORITY: readonly Standing[] = ["module:owner", "module:admin"];

function pick(...list: Standing[]): readonly Standing[] {
  return list;
}

function slug(standing: Standing): string {
  return standing.replace(":", "-");
}

function roleMemberHttp(world: WorldDb, standing: Standing, orgId: string, verb: "post" | "delete", principalId: string) {
  return probeHttp(world, {
    controllers: [RolesController],
    services: [{ provide: RolesService, useValue: rolesService(world) }],
    verb,
    path: `/roles/${roleIdOf("BUILD_MODULE_MEMBER", ORG_A)}/members`,
    body: { principalType: "user", principalId },
    permissionKey: "settings:rbac:manage",
    standing,
    orgId,
    serviceReads: "roles",
  });
}

function moduleAccessScenarios(world: WorldDb): Scenario[] {
  const memberTarget = membershipIdOf("module:member", ORG_A);
  const adminTarget = membershipIdOf("module:admin", ORG_A);
  const manage = STANDINGS.map((standing): Scenario => ({
    id: `module-access-manage-${slug(standing)}`,
    actor: standing,
    resource: "module-access:build",
    action: "manage-access",
    tenant: "same",
    state: "normal",
    expected: MANAGE_EXPECTED[standing],
    because: MANAGE_REASON[standing],
    pairedWith: MANAGE_EXPECTED[standing] === "allow" ? undefined : "module-access-manage-org-admin",
    bindings: [{ adapter: "service", entry: "assertModuleAccessPolicy(manage)", run: () => moduleAccessManage(world, standing, ORG_A) }],
  }));
  const grant = STANDINGS.map((standing): Scenario => {
    const allowed = GRANTORS.includes(standing);
    return {
      id: `module-standing-grant-${slug(standing)}`,
      actor: standing,
      resource: "module-access:standing",
      action: "grant-admin",
      tenant: "same",
      state: "normal",
      expected: allowed ? "allow" : "403",
      because: allowed
        ? "a standing that administers the module may seat a module admin at or below its own rank"
        : "a standing without module authority is refused before any role assignment is written",
      pairedWith: allowed ? undefined : "module-standing-grant-module-admin",
      bindings: [
        {
          adapter: "service",
          entry: "ModuleStandingMutationsService.grantAdminStanding",
          run: () => moduleStanding(world, "grant", standing, ORG_A, memberTarget),
        },
      ],
    };
  });
  const standingEntry = (verb: "grant" | "revoke") =>
    verb === "grant" ? "ModuleStandingMutationsService.grantAdminStanding" : "ModuleStandingMutationsService.revokeStanding";
  const extra: Scenario[] = [
    {
      id: "module-standing-grant-cross-tenant",
      actor: "org:admin",
      resource: "module-access:standing",
      action: "grant-admin",
      tenant: "other",
      state: "normal",
      expected: "404",
      because: "a membership id from another organisation is not found in the caller's tenant",
      pairedWith: "module-standing-grant-org-admin",
      bindings: [{ adapter: "service", entry: standingEntry("grant"), run: () => moduleStanding(world, "grant", "org:admin", ORG_B, memberTarget) }],
    },
    ...pick("org:admin", "module:owner").map((standing): Scenario => ({
      id: `module-standing-revoke-${slug(standing)}`,
      actor: standing,
      resource: "module-access:standing",
      action: "revoke",
      tenant: "same",
      state: "normal",
      expected: "allow",
      because: "a standing that administers the module may revoke a module admin's standing",
      bindings: [{ adapter: "service", entry: standingEntry("revoke"), run: () => moduleStanding(world, "revoke", standing, ORG_A, adminTarget) }],
    })),
    ...pick("org:member", "module:member", "outsider").map((standing): Scenario => ({
      id: `module-standing-revoke-${slug(standing)}`,
      actor: standing,
      resource: "module-access:standing",
      action: "revoke",
      tenant: "same",
      state: "normal",
      expected: "403",
      because: "a standing without module authority cannot revoke anyone's module standing",
      pairedWith: "module-standing-revoke-org-admin",
      bindings: [{ adapter: "service", entry: standingEntry("revoke"), run: () => moduleStanding(world, "revoke", standing, ORG_A, adminTarget) }],
    })),
    {
      id: "module-standing-revoke-cross-tenant",
      actor: "org:admin",
      resource: "module-access:standing",
      action: "revoke",
      tenant: "other",
      state: "normal",
      expected: "404",
      because: "revoking a membership id from another organisation answers not-found, never forbidden",
      pairedWith: "module-standing-revoke-org-admin",
      bindings: [{ adapter: "service", entry: standingEntry("revoke"), run: () => moduleStanding(world, "revoke", "org:admin", ORG_B, adminTarget) }],
    },
  ];
  return [...manage, ...grant, ...extra];
}

function roleMemberScenarios(world: WorldDb): Scenario[] {
  const assignee = userOf("org:member", ORG_A);
  const assign = STANDINGS.map((standing): Scenario => {
    const expected = ROLE_EXPECTED[standing];
    const bindings: AdapterBinding[] = [
      { adapter: "http", entry: "POST /roles/:roleId/members", run: () => roleMemberHttp(world, standing, ORG_A, "post", assignee) },
    ];
    if (!MODULE_AUTHORITY.includes(standing))
      bindings.push({
        adapter: "service",
        entry: "RoleMemberService.addRoleMember",
        run: () => roleMemberAdd(world, standing, ORG_A, roleIdOf("BUILD_MODULE_MEMBER", ORG_A), assignee),
      });
    return {
      id: `rbac-role-member-assign-${slug(standing)}`,
      actor: standing,
      resource: "rbac:role-member",
      action: "assign",
      tenant: "same",
      state: "normal",
      expected,
      because:
        expected === "allow"
          ? "org owners and org admins hold settings:rbac:manage and may assign a role whose grants they hold"
          : "module standings and plain members never hold settings:rbac:manage, so the route refuses",
      pairedWith: expected === "allow" ? undefined : "rbac-role-member-assign-org-admin",
      bindings,
    };
  });
  const delegated = MODULE_AUTHORITY.map((standing): Scenario => ({
    id: `rbac-role-member-delegate-${slug(standing)}`,
    actor: standing,
    resource: "rbac:role-member",
    action: "assign",
    tenant: "same",
    state: "normal",
    expected: "allow",
    because:
      "past the route, RoleMemberService applies the grant-subset rule, so a module authority may hand out its own module's member role; settings:rbac:manage on the route is the outer gate the HTTP scenario proves",
    bindings: [
      {
        adapter: "service",
        entry: "RoleMemberService.addRoleMember",
        run: () => roleMemberAdd(world, standing, ORG_A, roleIdOf("BUILD_MODULE_MEMBER", ORG_A), assignee),
      },
    ],
  }));
  return [
    ...assign,
    ...delegated,
    {
      id: "rbac-role-member-assign-cross-tenant",
      actor: "org:owner",
      resource: "rbac:role-member",
      action: "assign",
      tenant: "other",
      state: "normal",
      expected: "404",
      because: "a role id from another organisation is not found, so the probe is no existence oracle",
      pairedWith: "rbac-role-member-assign-org-owner",
      bindings: [
        { adapter: "http", entry: "POST /roles/:roleId/members", run: () => roleMemberHttp(world, "org:owner", ORG_B, "post", userOf("org:member", ORG_B)) },
        {
          adapter: "service",
          entry: "RoleMemberService.addRoleMember",
          run: () => roleMemberAdd(world, "org:owner", ORG_B, roleIdOf("BUILD_MODULE_MEMBER", ORG_A), userOf("org:member", ORG_B)),
        },
      ],
    },
    {
      id: "rbac-role-member-unassign-org-admin",
      actor: "org:admin",
      resource: "rbac:role-member",
      action: "unassign",
      tenant: "same",
      state: "normal",
      expected: "allow",
      because: "an org admin holds settings:rbac:manage and the real service removes the assignment",
      bindings: [{ adapter: "http", entry: "DELETE /roles/:roleId/members", run: () => roleMemberHttp(world, "org:admin", ORG_A, "delete", assignee) }],
    },
    ...pick("org:member", "module:admin", "outsider").map((standing): Scenario => ({
      id: `rbac-role-member-unassign-${slug(standing)}`,
      actor: standing,
      resource: "rbac:role-member",
      action: "unassign",
      tenant: "same",
      state: "normal",
      expected: "403",
      because: "without settings:rbac:manage the guard refuses before the service runs",
      pairedWith: "rbac-role-member-unassign-org-admin",
      bindings: [{ adapter: "http", entry: "DELETE /roles/:roleId/members", run: () => roleMemberHttp(world, standing, ORG_A, "delete", assignee) }],
    })),
  ];
}

export function accessScenarios(world: WorldDb): Scenario[] {
  return [...moduleAccessScenarios(world), ...roleMemberScenarios(world)];
}
