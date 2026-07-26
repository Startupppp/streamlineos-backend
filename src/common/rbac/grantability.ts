import { BadRequestException, ForbiddenException } from "@nestjs/common";

/**
 * Server-owned grantability rules (plan §5 "Backend-owned grantability").
 *
 * A role/permission write is rejected unless every requested permission is a subset of
 * the caller's own effective (grantable) permission set. This is the primary defence
 * against privilege escalation: a caller can never grant authority they do not themselves
 * hold. Organization Owners and Platform Admins bypass — their grantable set is the whole
 * catalog by definition.
 *
 * A small set of self-propagating administrative keys additionally require the caller to
 * hold organization-admin authority (`settings:manage`) — otherwise a narrow custom
 * "role manager" (who holds `settings:rbac:manage` only) could mint more RBAC managers and
 * escalate. Holding a key is necessary but, for these keys, not sufficient to propagate it.
 */
export const RESERVED_PROPAGATION_KEYS: ReadonlySet<string> = new Set([
  "settings:manage",
  "settings:rbac:manage",
]);

const ORG_ADMIN_KEY = "settings:manage";

export interface GrantabilityActor {
  isOrgOwner: boolean;
  isPlatformAdmin: boolean;
  /** Caller's effective permission keys (scope !== "none"). */
  grantable: ReadonlySet<string>;
}

/** Build the caller's grantable key set from a resolved `permission -> scope` map. */
export function toGrantableSet(resolved: ReadonlyMap<string, string>): Set<string> {
  const set = new Set<string>();
  for (const [key, scope] of resolved) {
    if (scope !== "none") set.add(key);
  }
  return set;
}

/**
 * Reject any permission key not present in the catalog. Unknown keys must fail loudly,
 * never be silently filtered (plan §5).
 */
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

/**
 * Assert the caller may grant every requested permission. Throws ForbiddenException on the
 * first violated rule. Owner / Platform Admin bypass. Assumes keys are already validated
 * against the catalog (call `assertKnownPermissionKeys` first).
 */
export function assertPermissionsGrantable(
  actor: GrantabilityActor,
  requestedKeys: readonly string[],
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
}
