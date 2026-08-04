import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  assertKnownPermissionKeys,
  assertPermissionsGrantable,
  toGrantableSet,
} from "../../common/rbac/grantability";
import type { DataScope } from "../access/access.types";
import { ALL_PERMISSION_NAMES } from "../rbac/permissions";

const CATALOG_KEYS: ReadonlySet<string> = new Set(ALL_PERMISSION_NAMES);

export function assertDelegationPolicy(
  actor: CurrentUserContext,
  resolved: ReadonlyMap<string, DataScope>,
  permissions: readonly string[],
  startsAt: Date,
  endsAt: Date,
  now: Date,
): void {
  assertKnownPermissionKeys(permissions, CATALOG_KEYS);
  assertPermissionsGrantable(
    {
      isOrgOwner: actor.isOrgOwner,
      grantable: toGrantableSet(resolved),
    },
    permissions,
  );
  if (!actor.isOrgOwner) {
    const scoped = permissions.filter((permission) => resolved.get(permission) !== "all");
    if (scoped.length > 0) {
      throw new ForbiddenException(
        `Delegations require all-scope permissions: ${scoped.slice(0, 5).join(", ")}`,
      );
    }
  }
  if (endsAt <= now) {
    throw new BadRequestException("endsAt must be in the future");
  }
  if (startsAt >= endsAt) {
    throw new BadRequestException("startsAt must be before endsAt");
  }
}
