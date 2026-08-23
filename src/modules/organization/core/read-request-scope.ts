import type { Request } from "express";
import type { DataScope } from "../../access/access.types";

export function readRequestScope(req: Request): DataScope {
  return req.rbacScope ?? "none";
}
