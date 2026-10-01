import type { Table } from "drizzle-orm";
import {
  moduleOwnerships,
  organizationMembers,
  roleAssignments,
  rolePermissionGrants,
  roles,
} from "src/db/schema";
import { ALL_PERMISSION_NAMES } from "src/modules/rbac/permissions";
import { scopeForGrant, systemRoleSpecs } from "src/modules/rbac/seed-system-roles";
import { AccessPermissionResolver, type ReadAccessTable } from "src/modules/access/access-permission.resolver";
import type { AccessService } from "src/modules/access/access.service";
import type { DataScope } from "src/modules/access/access.types";
import type { CurrentUserContext } from "src/common/auth/backend-claims";
import { humanSessionPrincipal } from "src/common/auth/principal";
import { ORG_MEMBER_ROLES } from "src/common/rbac/org-roles";
import { memberRowReader } from "../../helpers/membership-state-stub";
import { ORG_A, ORG_B, actorOf } from "../../helpers/authz-deny-harness";
import { standIn, type Row, type WorldDb } from "./world-db";

export { ORG_A, ORG_B };

export const STANDINGS = [
  "org:owner",
  "org:admin",
  "org:member",
  "module:owner",
  "module:admin",
  "module:member",
  "outsider",
] as const;

export type Standing = (typeof STANDINGS)[number];

export const MATRIX_MODULE = "build";

const ORG_BASE: Readonly<Record<string, number>> = { [ORG_A]: 100, [ORG_B]: 200 };

const ASSIGNED_ROLE_SLUG: Partial<Record<Standing, string>> = {
  "org:admin": ORG_MEMBER_ROLES.ORG_ADMIN,
  "module:owner": `${MATRIX_MODULE.toUpperCase()}_MODULE_OWNER`,
  "module:admin": `${MATRIX_MODULE.toUpperCase()}_MODULE_ADMIN`,
  "module:member": `${MATRIX_MODULE.toUpperCase()}_MODULE_MEMBER`,
};

const SPECS = systemRoleSpecs(new Set(ALL_PERMISSION_NAMES));

function baseOf(orgId: string): number {
  const base = ORG_BASE[orgId];
  if (base === undefined) throw new Error(`standings: no fixture base for ${orgId}`);
  return base;
}

export function userOf(standing: Standing, orgId: string): string {
  return `${orgId}:${standing}`;
}

export function membershipIdOf(standing: Standing, orgId: string): number {
  return baseOf(orgId) + STANDINGS.indexOf(standing) + 1;
}

export function roleIdOf(slug: string, orgId: string): number {
  const index = SPECS.findIndex((spec) => spec.slug === slug);
  if (index < 0) throw new Error(`standings: no system role ${slug}`);
  return baseOf(orgId) * 10 + index;
}

export function actorFor(standing: Standing, orgId: string): CurrentUserContext {
  const isOrgOwner = standing === "org:owner";
  return actorOf({
    userId: userOf(standing, orgId),
    orgId,
    role: standing === "org:admin" ? ORG_MEMBER_ROLES.ORG_ADMIN : ORG_MEMBER_ROLES.MEMBER,
    isOrgOwner,
    sessionId: `session-${userOf(standing, orgId)}`,
    principal: humanSessionPrincipal(membershipIdOf(standing, orgId), isOrgOwner),
  });
}

export function standingRows(orgId: string): Map<Table, Row[]> {
  const roleRows: Row[] = SPECS.map((spec) => ({
    id: roleIdOf(spec.slug, orgId),
    orgId,
    slug: spec.slug,
    name: spec.name,
    rank: spec.rank,
    moduleKey: spec.moduleKey,
    isSystem: true,
  }));
  let grantId = baseOf(orgId) * 10_000;
  const grantRows: Row[] = SPECS.flatMap((spec) =>
    spec.permissionKeys.map((permissionKey) => {
      grantId += 1;
      return {
        id: grantId,
        orgId,
        roleId: roleIdOf(spec.slug, orgId),
        permissionKey,
        scope: scopeForGrant(spec.slug, permissionKey),
      };
    }),
  );
  const memberRows: Row[] = STANDINGS.filter((standing) => standing !== "outsider").map((standing) => ({
    id: membershipIdOf(standing, orgId),
    orgId,
    userId: userOf(standing, orgId),
    status: "ACTIVE",
    isOwner: standing === "org:owner",
    role: standing === "org:admin" ? ORG_MEMBER_ROLES.ORG_ADMIN : ORG_MEMBER_ROLES.MEMBER,
  }));
  const assignmentRows: Row[] = STANDINGS.flatMap((standing) => {
    const slug = ASSIGNED_ROLE_SLUG[standing];
    if (slug === undefined) return [];
    const spec = SPECS.find((candidate) => candidate.slug === slug);
    return [
      {
        id: `ra-${membershipIdOf(standing, orgId)}`,
        orgId,
        organizationMembershipId: membershipIdOf(standing, orgId),
        roleId: roleIdOf(slug, orgId),
        expiresAt: null,
        userId: userOf(standing, orgId),
        status: "ACTIVE",
        rank: spec?.rank,
        moduleKey: spec?.moduleKey,
      },
    ];
  });
  const ownershipRows: Row[] = [
    {
      id: `mo-${orgId}`,
      orgId,
      moduleKey: MATRIX_MODULE,
      ownerMembershipId: membershipIdOf("module:owner", orgId),
      userId: userOf("module:owner", orgId),
    },
  ];
  return new Map<Table, Row[]>([
    [roles, roleRows],
    [rolePermissionGrants, grantRows],
    [organizationMembers, memberRows],
    [roleAssignments, assignmentRows],
    [moduleOwnerships, ownershipRows],
  ]);
}

const readAccessTable: ReadAccessTable = async (read) => read();

export async function resolvedScopes(
  world: WorldDb,
  orgId: string,
  userId: string,
): Promise<Record<string, DataScope>> {
  const member = (world.rows.get(organizationMembers) ?? []).find(
    (row) => row.orgId === orgId && row.userId === userId,
  );
  const resolver = new AccessPermissionResolver(
    () => world.db,
    readAccessTable,
    new Set<string>(),
    new Map(),
    1000,
    memberRowReader({
      isOwner: member?.isOwner === true,
      status: typeof member?.status === "string" ? member.status : "ABSENT",
      id: typeof member?.id === "number" ? member.id : null,
      role: typeof member?.role === "string" ? member.role : ORG_MEMBER_ROLES.MEMBER,
    }),
  );
  return (await resolver.computeUserPermissions(orgId, userId, 1)).perms;
}

export function accessFor(world: WorldDb, overrides: Readonly<Record<string, DataScope>> = {}): AccessService {
  const permissions = async (orgId: string, userId: string): Promise<Map<string, DataScope>> =>
    new Map(Object.entries({ ...(await resolvedScopes(world, orgId, userId)), ...overrides }));
  return standIn<AccessService>({
    resolveUserPermissions: permissions,
    scopeFor: async (user: CurrentUserContext, key: string): Promise<DataScope> =>
      (await permissions(user.orgId, user.userId)).get(key) ?? "none",
    holds: async (user: CurrentUserContext, key: string): Promise<boolean> =>
      ((await permissions(user.orgId, user.userId)).get(key) ?? "none") !== "none",
    isModuleEnabled: async (): Promise<boolean> => true,
  });
}
