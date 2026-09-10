import { ScopedRead } from "../../access/scoped-read";
import { scopeFor, type Permissions } from "../../entity-reference/entity-scope";
import type { EntityActor } from "../../entity-reference/entity-reference.types";

export function crmEntityReadScope(
  actor: EntityActor,
  permissions: Permissions,
  readKey: string,
): ScopedRead {
  return ScopedRead.of(actor.orgId, actor.userId, scopeFor(actor, permissions, readKey));
}
