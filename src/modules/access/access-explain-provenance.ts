import type { MembershipState } from "../../common/auth/membership-state.service";
import { isDelegablePermission } from "../../common/rbac/grantability";
import {
  ORG_MEMBER_ROLES,
  isOrgMemberRole,
  type OrgMemberRole,
} from "../../common/rbac/org-roles";
import { administeringModuleOf } from "../../common/rbac/module-vocabulary";
import type { DataScope } from "./access.types";
import {
  CATALOG_KEY_SET,
  broadest,
  deriveAccessViewImplication,
} from "./access-policy";

export const GRANT_SOURCE_KINDS = [
  "org-standing",
  "universal-member",
  "employee-self-service",
  "role-grant",
  "role-default",
  "delegation",
  "user-grant",
  "module-ownership",
  "platform-capability",
  "access-view-implication",
] as const;

export type GrantSourceKind = (typeof GRANT_SOURCE_KINDS)[number];

export const MODULE_STANDINGS = ["owner", "admin", "member", "none"] as const;

export type ModuleStanding = (typeof MODULE_STANDINGS)[number];

export interface GrantSource {
  kind: GrantSourceKind;
  label: string;
  scope: DataScope;
  moduleKey: string | null;
  expiresAt: Date | null;
}

export interface ExplainedPermission {
  permissionKey: string;
  moduleKey: string;
  scope: DataScope;
  expiresAt: Date | null;
  sources: GrantSource[];
}

export interface ExplainedModuleStanding {
  moduleKey: string;
  standing: ModuleStanding;
  available: boolean;
  permissionCount: number;
}

export interface AccessExplanation {
  standing: OrgMemberRole;
  active: boolean;
  permissions: ExplainedPermission[];
  moduleStandings: ExplainedModuleStanding[];
}

/**
 * The effective scope map implied by a provenance walk.
 *
 * This exists so `access-explain.resolver.spec.ts` can put the walk and
 * `AccessPermissionResolver.computeUserPermissions` over one fixture and assert
 * the two maps are identical. A provenance view that drifts from the resolver
 * shows rights the API does not grant, so the derivation has to be checkable
 * from outside the class.
 */
export function effectiveScopesOf(
  permissions: readonly ExplainedPermission[],
): Record<string, DataScope> {
  const scopes: Record<string, DataScope> = {};
  for (const entry of permissions) scopes[entry.permissionKey] = entry.scope;
  return scopes;
}

/**
 * Attribution laid over an authoritative scope map, never the other way round.
 *
 * `AccessService.resolveUserPermissions` is what every guard enforces, and it
 * also strips the person's denied modules — something the provenance walk does
 * not model, because a denial removes a key rather than granting one. Anything
 * the authority dropped is dropped here too, and the surviving keys take the
 * authority's scope, so a displayed right cannot outrun the API.
 */
export function restrictExplanationTo(
  explanation: AccessExplanation,
  effective: Readonly<Record<string, DataScope>>,
): Pick<AccessExplanation, "permissions" | "moduleStandings"> {
  const permissions = explanation.permissions
    .filter((entry) => effective[entry.permissionKey] !== undefined)
    .map((entry) => ({
      ...entry,
      scope: effective[entry.permissionKey] ?? entry.scope,
    }));
  const counts = new Map<string, number>();
  for (const entry of permissions)
    counts.set(entry.moduleKey, (counts.get(entry.moduleKey) ?? 0) + 1);
  const moduleStandings = explanation.moduleStandings
    .filter(
      (standing) =>
        counts.has(standing.moduleKey) || standing.standing === "owner",
    )
    .map((standing) => ({
      ...standing,
      permissionCount: counts.get(standing.moduleKey) ?? 0,
    }));
  return { permissions, moduleStandings };
}

export function orgStandingOf(member: MembershipState): OrgMemberRole {
  if (member.isOwner) return ORG_MEMBER_ROLES.OWNER;
  if (isOrgMemberRole(member.role)) return member.role;
  return ORG_MEMBER_ROLES.MEMBER;
}

export function ownsOrAdministers(member: MembershipState): boolean {
  return (
    member.active &&
    (member.isOwner || member.role === ORG_MEMBER_ROLES.ORG_ADMIN)
  );
}

export function moduleStandingOf(
  moduleKey: string,
  ownedModules: ReadonlySet<string>,
  administersOrg: boolean,
  held: ReadonlySet<string>,
  permissionCount: number,
): ModuleStanding {
  if (ownedModules.has(moduleKey)) return "owner";
  if (administersOrg || held.has(`${moduleKey}:access:manage`)) return "admin";
  return permissionCount > 0 ? "member" : "none";
}

function canonicalKeyOf(permissionKey: string): string {
  return permissionKey === "hr:employees:read"
    ? "hr:employees:view"
    : permissionKey;
}

function earliestExpiry(sources: readonly GrantSource[]): Date | null {
  if (sources.length === 0) return null;
  let earliest: Date | null = null;
  for (const source of sources) {
    if (source.expiresAt === null) return null;
    if (earliest === null || source.expiresAt < earliest)
      earliest = source.expiresAt;
  }
  return earliest;
}

/**
 * The merge rule, kept in one place so the resolver's two entry points cannot
 * answer a key differently. `merge` and `mergeIfKnown` mirror the two folds in
 * `AccessPermissionResolver.computeUserPermissions` exactly, including the
 * `hr:employees:read` canonicalisation and the org-only bar: a key that never
 * reaches the effective map must never appear as displayed provenance either.
 */
export class ProvenanceWalk {
  private readonly scopes: Record<string, DataScope> = {};
  private readonly sources = new Map<string, GrantSource[]>();

  merge(permissionKey: string, scope: DataScope, source: GrantSource): void {
    const existing = this.scopes[permissionKey];
    this.scopes[permissionKey] = existing ? broadest(existing, scope) : scope;
    const list = this.sources.get(permissionKey) ?? [];
    list.push(source);
    this.sources.set(permissionKey, list);
  }

  mergeIfKnown(
    permissionKey: string,
    scope: DataScope,
    source: GrantSource,
  ): void {
    const canonicalKey = canonicalKeyOf(permissionKey);
    if (!isDelegablePermission(canonicalKey)) return;
    if (!CATALOG_KEY_SET.has(canonicalKey)) return;
    this.merge(canonicalKey, scope, source);
  }

  applyAccessViewImplication(): void {
    const before: Record<string, DataScope> = { ...this.scopes };
    deriveAccessViewImplication(this.scopes);
    for (const [permissionKey, scope] of Object.entries(this.scopes)) {
      if (before[permissionKey] === scope) continue;
      const list = this.sources.get(permissionKey) ?? [];
      list.push({
        kind: "access-view-implication",
        label: "Implied by the module's manage permission",
        scope,
        moduleKey: administeringModuleOf(permissionKey),
        expiresAt: null,
      });
      this.sources.set(permissionKey, list);
    }
  }

  collect(): ExplainedPermission[] {
    return Object.entries(this.scopes)
      .map(([permissionKey, scope]) => {
        const sources = this.sources.get(permissionKey) ?? [];
        return {
          permissionKey,
          moduleKey: administeringModuleOf(permissionKey),
          scope,
          expiresAt: earliestExpiry(sources),
          sources,
        };
      })
      .sort((left, right) =>
        left.permissionKey.localeCompare(right.permissionKey),
      );
  }
}
