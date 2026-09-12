import { administeringModuleOf, namespaceOf } from "./module-vocabulary";
import { BadRequestException, ForbiddenException } from "@nestjs/common";

export const ROLE_RANK = {
  ORG_OWNER: 0,
  ORG_ADMIN: 10,
  MODULE_OWNER: 15,
  MODULE_ADMIN: 20,
  MODULE_CUSTOM: 30,
  FUNCTIONAL: 40,
} as const satisfies Record<string, number>;

export const RESERVED_PROPAGATION_KEYS: ReadonlySet<string> = new Set([
  "settings:manage",
  "settings:rbac:manage",
]);

const ORG_ONLY_NAMESPACES: readonly string[] = ["billing"];

const ORG_ONLY_PERMISSION_KEYS: ReadonlySet<string> = new Set([
  "chat:org-settings:manage",
]);

/**
 * Keys that administer a resource the vendor owns globally rather than one a
 * tenant owns. `blog_posts` and `blog_categories` have no `org_id` because they
 * are the vendor's public marketing site, so no tenant standing — owner, org
 * admin, module owner, role grant or delegation — may confer them. They are
 * held only through `isPlatformAdmin` (`platform-operators.ts`), which is
 * deployment configuration and not organization data.
 */
export const PLATFORM_ONLY_PERMISSION_KEYS: ReadonlySet<string> = new Set([
  "blog:posts:manage",
  "blog:categories:manage",
  "blog:ai:use",
  "billing:promotions:view",
  "billing:promotions:manage",
]);

function isOrgOnlyNamespace(key: string): boolean {
  return ORG_ONLY_NAMESPACES.includes(namespaceOf(key));
}

export function isOrgOnlyPermission(key: string): boolean {
  return isOrgOnlyNamespace(key) || ORG_ONLY_PERMISSION_KEYS.has(key);
}

export function isPlatformOnlyPermission(key: string): boolean {
  return PLATFORM_ONLY_PERMISSION_KEYS.has(key);
}

export function isDelegablePermission(key: string): boolean {
  return !isOrgOnlyPermission(key) && !isPlatformOnlyPermission(key);
}

export const ORG_ADMIN_PERMISSION_KEY = "settings:manage";

export interface GrantabilityActor {
  isOrgOwner: boolean;
  grantable: ReadonlySet<string>;
  bestRank?: number;
  allowedModules?: ReadonlySet<string> | null;
}

/**
 * The single rank comparison shared by the read path (describeGrantable) and
 * the write path (assertPermissionsGrantable). If either side reimplements this
 * logic, the UI can advertise grants the writer refuses — which is why this
 * function exists and both sides must import it here rather than copy the check.
 *
 * Returns true when the actor at `actorBestRank` may grant to a role whose
 * authority is `targetRank` in `targetModuleKey`. Does not check permission
 * content or scope — those are separate checks.
 *
 * The peer-MODULE_ADMIN exception: an admin at rank 20 may configure a
 * MODULE_ADMIN role in the same module (rank equality normally blocks this)
 * because module self-administration requires being able to set peers.
 */
export function canGrantToRank(
  actorBestRank: number,
  actorAllowedModules: ReadonlySet<string> | null | undefined,
  targetRank: number,
  targetModuleKey: string | null,
): boolean {
  const isPeerModuleAdmin =
    actorBestRank === ROLE_RANK.MODULE_ADMIN &&
    targetRank === ROLE_RANK.MODULE_ADMIN &&
    actorAllowedModules !== null &&
    actorAllowedModules !== undefined &&
    targetModuleKey !== null &&
    actorAllowedModules.has(targetModuleKey);

  return isPeerModuleAdmin || targetRank > actorBestRank;
}

export interface RoleGrantTarget {
  rank: number;
  moduleKey: string | null;
}

export type PermissionAdministeringModuleMap = ReadonlyMap<string, string | null>;

export function toGrantableSet(
  resolved: ReadonlyMap<string, string>,
): Set<string> {
  const set = new Set<string>();
  for (const [key, scope] of resolved) {
    if (scope !== "none") set.add(key);
  }
  return set;
}

// A module admin's authority is measured against the ADMINISTERING module (a CRM admin may grant `party:*`); a key with no namespace segment is owned by nobody and `null` denies it.
export function buildPermissionAdministeringModuleMap(
  keys: readonly string[],
): PermissionAdministeringModuleMap {
  const map = new Map<string, string | null>();
  for (const key of keys) {
    const hasNamespaceSegment = namespaceOf(key) !== key;
    map.set(key, hasNamespaceSegment ? administeringModuleOf(key) : null);
  }
  return map;
}

export function assertKnownPermissionKeys(
  requestedKeys: readonly string[],
  catalog: ReadonlySet<string>,
): void {
  const unknown = requestedKeys.filter((key) => !catalog.has(key));
  if (unknown.length > 0) {
    const preview = unknown.slice(0, 5).join(", ");
    throw new BadRequestException(
      `Unknown permission key${unknown.length > 1 ? "s" : ""}: ${preview}${
        unknown.length > 5 ? ` (+${unknown.length - 5} more)` : ""
      }`,
    );
  }
}

export function assertPermissionsGrantable(
  actor: GrantabilityActor,
  requestedKeys: readonly string[],
  target?: RoleGrantTarget,
  administeringModules?: PermissionAdministeringModuleMap,
): void {
  const orgOnly = requestedKeys.filter(isOrgOnlyNamespace);
  if (orgOnly.length > 0) {
    throw new ForbiddenException(
      `Platform billing is managed by the organization owner and administrators only, and cannot be granted: ${orgOnly.join(", ")}`,
    );
  }

  const platformOnly = requestedKeys.filter(isPlatformOnlyPermission);
  if (platformOnly.length > 0) {
    throw new ForbiddenException(
      `Platform-owned content is administered by the vendor, not by an organization, and cannot be granted: ${platformOnly.join(", ")}`,
    );
  }

  const orgOnlyKeys = requestedKeys.filter((key) =>
    ORG_ONLY_PERMISSION_KEYS.has(key),
  );
  if (orgOnlyKeys.length > 0) {
    throw new ForbiddenException(
      `Organization-wide settings are managed by the organization owner and administrators only, and cannot be granted: ${orgOnlyKeys.join(", ")}`,
    );
  }

  if (actor.isOrgOwner) return;

  const notHeld = requestedKeys.filter((key) => !actor.grantable.has(key));
  if (notHeld.length > 0) {
    const preview = notHeld.slice(0, 5).join(", ");
    throw new ForbiddenException(
      `You cannot grant permissions you do not hold: ${preview}${
        notHeld.length > 5 ? ` (+${notHeld.length - 5} more)` : ""
      }`,
    );
  }

  if (!actor.grantable.has(ORG_ADMIN_PERMISSION_KEY)) {
    const reserved = requestedKeys.filter((key) =>
      RESERVED_PROPAGATION_KEYS.has(key),
    );
    if (reserved.length > 0) {
      throw new ForbiddenException(
        `Only an organization owner or administrator can grant: ${reserved.join(", ")}`,
      );
    }
  }

  if (target !== undefined && actor.bestRank !== undefined) {
    if (!canGrantToRank(actor.bestRank, actor.allowedModules, target.rank, target.moduleKey)) {
      throw new ForbiddenException(
        `You cannot create or modify a role at authority rank ${target.rank}; your highest rank is ${actor.bestRank}`,
      );
    }
  }

  const allowedModules = actor.allowedModules;
  if (
    allowedModules !== undefined &&
    allowedModules !== null &&
    administeringModules !== undefined &&
    requestedKeys.length > 0
  ) {
    const crossModule = requestedKeys.filter((key) => {
      const administeringModule = administeringModules.get(key);
      return (
        administeringModule === undefined ||
        administeringModule === null ||
        !allowedModules.has(administeringModule)
      );
    });
    if (crossModule.length > 0) {
      const modules = Array.from(allowedModules).join(", ");
      const preview = crossModule.slice(0, 5).join(", ");
      throw new ForbiddenException(
        `As a module administrator for [${modules}], you may only grant permissions within that module: ${preview}${
          crossModule.length > 5 ? ` (+${crossModule.length - 5} more)` : ""
        }`,
      );
    }
  }
}

export function isImmutableSystemRole(role: {
  isSystem: boolean;
  moduleKey: string | null;
}): boolean {
  return role.isSystem && !role.moduleKey;
}
