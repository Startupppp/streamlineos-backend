import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { ScopedRead } from "../../access/scoped-read";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";

const INV_PRODUCTS_READ = "inventory:products:read";
const INV_PO_READ = "inventory:purchase-orders:read";
const INV_SO_READ = "inventory:sales-orders:read";
const INV_STOCK_READ = "inventory:stock:read";

async function resolveInventoryScope(
  permission: string,
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  if (!isScopable(permission)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(permission) ?? "none";
}

export async function resolveInvProductsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  return ScopedRead.of(u.orgId, u.userId, await resolveInventoryScope(INV_PRODUCTS_READ, access, u));
}

export async function resolveInvPoScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  return ScopedRead.of(u.orgId, u.userId, await resolveInventoryScope(INV_PO_READ, access, u));
}

export async function resolveInvSoScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  return ScopedRead.of(u.orgId, u.userId, await resolveInventoryScope(INV_SO_READ, access, u));
}

export async function resolveInvStockScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  return ScopedRead.of(u.orgId, u.userId, await resolveInventoryScope(INV_STOCK_READ, access, u));
}
