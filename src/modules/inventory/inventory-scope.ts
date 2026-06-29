import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { isScopable } from "../rbac/permissions.constants";

const INV_PRODUCTS_READ = "inventory:products:read";
const INV_PO_READ = "inventory:purchase-orders:read";
const INV_SO_READ = "inventory:sales-orders:read";
const INV_STOCK_READ = "inventory:stock:read";

async function resolveInventoryScope(
  permission: string,
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isPlatformAdmin || u.isOrgOwner) return "all";
  if (!isScopable(permission)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(permission) ?? "none";
}

export function resolveInvProductsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  return resolveInventoryScope(INV_PRODUCTS_READ, access, u);
}

export function resolveInvPoScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  return resolveInventoryScope(INV_PO_READ, access, u);
}

export function resolveInvSoScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  return resolveInventoryScope(INV_SO_READ, access, u);
}

export function resolveInvStockScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  return resolveInventoryScope(INV_STOCK_READ, access, u);
}
