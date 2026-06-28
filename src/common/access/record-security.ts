import type { CurrentUserContext } from "../auth/backend-claims";

export type OrgWideDefault = "PRIVATE" | "PUBLIC_READ" | "PUBLIC_READ_WRITE";

export interface RecordOwnership {
  ownerId: string;
  teamId?: string;
}

export function canReadRecord(
  ctx: CurrentUserContext,
  owd: OrgWideDefault,
  record: RecordOwnership,
): boolean {
  if (ctx.isPlatformAdmin || ctx.isOrgOwner) return true;
  if (owd === "PUBLIC_READ" || owd === "PUBLIC_READ_WRITE") return true;
  if (record.ownerId === ctx.userId) return true;
  return false;
}

export function canWriteRecord(
  ctx: CurrentUserContext,
  owd: OrgWideDefault,
  record: RecordOwnership,
): boolean {
  if (ctx.isPlatformAdmin || ctx.isOrgOwner) return true;
  if (owd === "PUBLIC_READ_WRITE") return true;
  if (record.ownerId === ctx.userId) return true;
  return false;
}

export function buildOwnerFilter(
  ctx: CurrentUserContext,
  owd: OrgWideDefault,
): "all" | { ownerId: string } {
  if (ctx.isPlatformAdmin || ctx.isOrgOwner) return "all";
  if (owd === "PUBLIC_READ" || owd === "PUBLIC_READ_WRITE") return "all";
  return { ownerId: ctx.userId };
}
