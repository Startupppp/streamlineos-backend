import { NotFoundException } from "@nestjs/common";
import { eq, isNull } from "drizzle-orm";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ScopedRead } from "../access/scoped-read";
import { AccessService } from "../access/access.service";
import { deals } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";
import { isScopable } from "../rbac/permissions";

export const DEALS_READ_PERMISSION = "crm:deals:read";

export async function resolveDealsReadScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  if (u.isOrgOwner) return ScopedRead.of(u.orgId, u.userId, "all");
  if (!isScopable(DEALS_READ_PERMISSION)) return ScopedRead.of(u.orgId, u.userId, "all");
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return ScopedRead.of(u.orgId, u.userId, resolved.get(DEALS_READ_PERMISSION) ?? "none");
}

export async function assertDealInScope(db: Db, read: ScopedRead, dealId: number): Promise<void> {
  const deal = await read.read(
    {
      tenant: deals.orgId,
      scope: { columns: { ownerColumn: deals.assignedToId } },
      and: [eq(deals.id, dealId), isNull(deals.deletedAt)],
    },
    ({ sql: where }) => db.query.deals.findFirst({ where, columns: { id: true } }),
    () => undefined,
  );
  if (!deal) throw new NotFoundException("Deal not found");
}
