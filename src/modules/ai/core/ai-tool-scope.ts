import type { AccessService } from "../../access/access.service";
import { ScopedRead, type ScopeActor } from "../../access/scoped-read";

/** An AI tool's view of one permission key, resolved for the asking member. */
export async function resolveToolScope(
  access: Pick<AccessService, "resolveUserPermissions">,
  actor: ScopeActor,
  permissionKey: string,
): Promise<ScopedRead> {
  const perms = await access.resolveUserPermissions(actor.orgId, actor.userId);
  return ScopedRead.of(
    actor.orgId,
    actor.userId,
    perms.get(permissionKey) ?? "none",
  );
}
