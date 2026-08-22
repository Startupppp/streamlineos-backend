import { moduleOwningNamespace } from "./module-vocabulary";
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

/**
 * Platform billing is deliberately NOT delegatable: it is run by the
 * organisation owner and organisation administrators only, who hold the whole
 * catalog structurally and never need a grant. Barring the namespace from every
 * grant path — including the owner's own — is what makes "org owner and org
 * admin only" true by construction rather than by convention, so there is no
 * billing owner rung to appoint and no per-person billing grant to write.
 * This is platform billing; the organisation's own customer invoicing lives in
 * accounting and is unaffected.
 */
const ORG_ONLY_NAMESPACES: readonly string[] = ["billing"];

/**
 * Organisation-wide chat settings are run by the organisation owner and
 * organisation admins, who already hold the whole catalog structurally. Barring
 * the key from every grant path is what makes that true by construction:
 * migration 0437 had handed it to CHAT_MODULE_ADMIN, and 0441 only reclaimed
 * the roles nobody had been appointed to, so a module admin could otherwise
 * still hold it. Huddle moderation stays delegatable — it moderates a
 * conversation, it does not reconfigure the organisation.
 */
const ORG_ONLY_PERMISSION_KEYS: ReadonlySet<string> = new Set([
  "chat:org-settings:manage",
]);

function isOrgOnlyNamespace(key: string): boolean {
  return ORG_ONLY_NAMESPACES.includes(key.split(":")[0] ?? "");
}

export function isOrgOnlyPermission(key: string): boolean {
  return isOrgOnlyNamespace(key) || ORG_ONLY_PERMISSION_KEYS.has(key);
}

/**
 * The reserved key itself, for PROPAGATION checks only — "may this actor grant
 * this key to someone else". It must never be used to decide whether the actor
 * IS an org admin; that is structural, via `isStructuralOrgAdmin`. The former
 * `grantsOrgAdmin()` helper did exactly that and was removed (AC-04, §21).
 */
export const ORG_ADMIN_PERMISSION_KEY = "settings:manage";

export interface GrantabilityActor {
  isOrgOwner: boolean;
  grantable: ReadonlySet<string>;
  bestRank?: number;
  allowedModules?: ReadonlySet<string> | null;
}

export interface RoleGrantTarget {
  rank: number;
  moduleKey: string | null;
}

export type PermissionModuleMap = ReadonlyMap<string, string | null>;

export function toGrantableSet(
  resolved: ReadonlyMap<string, string>,
): Set<string> {
  const set = new Set<string>();
  for (const [key, scope] of resolved) {
    if (scope !== "none") set.add(key);
  }
  return set;
}

export function buildPermissionModuleMap(
  keys: readonly string[],
): PermissionModuleMap {
  const map = new Map<string, string | null>();
  for (const key of keys) {
    const idx = key.indexOf(":");
    map.set(key, idx === -1 ? null : moduleOwningNamespace(key.slice(0, idx)));
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
  permissionMeta?: PermissionModuleMap,
): void {
  const orgOnly = requestedKeys.filter(isOrgOnlyNamespace);
  if (orgOnly.length > 0) {
    throw new ForbiddenException(
      `Platform billing is managed by the organization owner and administrators only, and cannot be granted: ${orgOnly.join(", ")}`,
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
    const isPeerModuleAdmin =
      actor.bestRank === ROLE_RANK.MODULE_ADMIN &&
      target.rank === ROLE_RANK.MODULE_ADMIN &&
      actor.allowedModules !== null &&
      actor.allowedModules !== undefined &&
      target.moduleKey !== null &&
      actor.allowedModules.has(target.moduleKey);

    if (!isPeerModuleAdmin && target.rank <= actor.bestRank) {
      throw new ForbiddenException(
        `You cannot create or modify a role at authority rank ${target.rank}; your highest rank is ${actor.bestRank}`,
      );
    }
  }

  const allowedModules = actor.allowedModules;
  if (
    allowedModules !== undefined &&
    allowedModules !== null &&
    permissionMeta !== undefined &&
    requestedKeys.length > 0
  ) {
    const crossModule = requestedKeys.filter((key) => {
      const keyModule = permissionMeta.get(key);
      return (
        keyModule === undefined ||
        keyModule === null ||
        !allowedModules.has(keyModule)
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
