import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import type { AccessService } from "../access/access.service";

export async function buildScopedDashboardCacheKey(
  access: AccessService,
  u: CurrentUserContext,
  resource: string,
  scope: DataScope,
  dimension?: string,
): Promise<string> {
  const version = await access.getPermissionsVersion(u.orgId);
  const base = `dashboard-home:${u.orgId}:u${u.userId}:v${version}:${resource}:${scope}`;
  return dimension ? `${base}:${dimension}` : base;
}

export async function buildOrgDashboardCacheKey(
  access: AccessService,
  orgId: string,
  resource: string,
  dimension?: string,
): Promise<string> {
  const version = await access.getPermissionsVersion(orgId);
  const base = `dashboard-home:${orgId}:v${version}:${resource}`;
  return dimension ? `${base}:${dimension}` : base;
}
