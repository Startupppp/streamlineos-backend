import type { AuthContext } from "../../../common/auth/auth-context";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { AccessService } from "../../access/access.service";
import type { AccessSnapshot } from "../../access/access.types";
import { ScopedRead, type ScopeActor } from "../../access/scoped-read";

export type AskOsToolReader = (permissionKey: string) => ScopedRead;

export function askOsToolReader(actor: ScopeActor, snapshot: AccessSnapshot): AskOsToolReader {
  return (permissionKey) =>
    ScopedRead.of(actor.orgId, actor.userId, snapshot.scopes[permissionKey] ?? "none");
}

export function askOsToolRead(
  actor: ScopeActor,
  snapshot: AccessSnapshot,
  permissionKey: string | undefined,
): ScopedRead {
  if (permissionKey === undefined) return ScopedRead.of(actor.orgId, actor.userId, "all");
  return askOsToolReader(actor, snapshot)(permissionKey);
}

export async function resolveAskOsToolRead(
  access: Pick<AccessService, "scopeFor">,
  actor: CurrentUserContext,
  permissionKey: string,
  authContext?: AuthContext,
): Promise<ScopedRead> {
  return ScopedRead.of(
    actor.orgId,
    actor.userId,
    await access.scopeFor(actor, permissionKey, authContext),
  );
}
