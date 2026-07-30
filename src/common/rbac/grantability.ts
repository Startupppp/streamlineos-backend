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

const ORG_ADMIN_KEY = "settings:manage";

export interface GrantabilityActor {
  isOrgOwner: boolean;
  isPlatformAdmin: boolean;
  grantable: ReadonlySet<string>;
  bestRank?: number;
  allowedModules?: ReadonlySet<string> | null;
}

export interface RoleGrantTarget {
  rank: number;
  moduleKey: string | null;
}

export type PermissionModuleMap = ReadonlyMap<string, string | null>;

export function toGrantableSet(resolved: ReadonlyMap<string, string>): Set<string> {
  const set = new Set<string>();
  for (const [key, scope] of resolved) {
    if (scope !== "none") set.add(key);
  }
  return set;
}

export function buildPermissionModuleMap(keys: readonly string[]): PermissionModuleMap {
  const map = new Map<string, string | null>();
  for (const key of keys) {
    const idx = key.indexOf(":");
    map.set(key, idx === -1 ? null : key.slice(0, idx));
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
  if (actor.isOrgOwner || actor.isPlatformAdmin) return;

  const notHeld = requestedKeys.filter((key) => !actor.grantable.has(key));
  if (notHeld.length > 0) {
    const preview = notHeld.slice(0, 5).join(", ");
    throw new ForbiddenException(
      `You cannot grant permissions you do not hold: ${preview}${
        notHeld.length > 5 ? ` (+${notHeld.length - 5} more)` : ""
      }`,
    );
  }

  if (!actor.grantable.has(ORG_ADMIN_KEY)) {
    const reserved = requestedKeys.filter((key) => RESERVED_PROPAGATION_KEYS.has(key));
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
        keyModule === undefined || keyModule === null || !allowedModules.has(keyModule)
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
