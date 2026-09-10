import type { Request } from "express";
import type { DataScope } from "../../access/access.types";
import { ScopedRead, type ScopeActor } from "../../access/scoped-read";

export function readRequestScope(req: Request): DataScope {
  return req.rbacScope ?? "none";
}

// PermissionGuard already resolved the scope for the route's key; absence denies.
export function readRequestScopedRead(req: Request, actor: ScopeActor): ScopedRead {
  return ScopedRead.of(actor.orgId, actor.userId, readRequestScope(req));
}
