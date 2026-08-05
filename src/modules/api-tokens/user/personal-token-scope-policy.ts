import type { AccessSnapshot } from "../../access/access.types";
import { PERMISSIONS, type Permission } from "../../rbac/permissions";
import { isPersonalTokenPermissionDelegable } from "../../../common/rbac/personal-token-policy";

function belongsToDisabledModule(
  permissionKey: string,
  modules: Readonly<Record<string, boolean>>,
): boolean {
  const moduleKey = permissionKey.split(":", 1)[0];
  if (!moduleKey || !(moduleKey in modules)) return false;
  return modules[moduleKey] !== true;
}

/**
 * Personal tokens are attenuated credentials: they may only contain a current
 * user permission, from an enabled module, and never account/organization
 * administration capabilities that could mint credentials or change access.
 */
export function grantablePersonalTokenPermissions(
  snapshot: AccessSnapshot,
): Permission[] {
  const granted = new Set(snapshot.permissions);
  return PERMISSIONS.filter(
    (permission) =>
      granted.has(permission.name) &&
      !belongsToDisabledModule(permission.name, snapshot.modules) &&
      isPersonalTokenPermissionDelegable(permission.name),
  );
}
