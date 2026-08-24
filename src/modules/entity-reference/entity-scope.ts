import type { DataScope } from "../access/access.types";
import type { EntityActor } from "./entity-reference.types";

export type Permissions = Map<string, DataScope>;

export function scopeFor(
  actor: EntityActor,
  permissions: Permissions,
  key: string,
): DataScope {
  if (actor.isOrgOwner) return "all";
  return permissions.get(key) ?? "none";
}

export function holds(
  actor: EntityActor,
  permissions: Permissions,
  key: string,
): boolean {
  return scopeFor(actor, permissions, key) !== "none";
}
