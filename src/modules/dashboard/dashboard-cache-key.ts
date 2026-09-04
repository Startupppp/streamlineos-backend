import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import type { AccessService } from "../access/access.service";
import {
  cacheNamespaceOf,
  type OrgCachedSectionKey,
  type ScopedCachedSectionKey,
} from "./dashboard-section-registry";

export async function buildScopedDashboardCacheKey(
  access: AccessService,
  u: CurrentUserContext,
  resource: string,
  scope: DataScope,
  dimension?: string,
  locale?: string,
): Promise<string> {
  const version = await access.getPermissionsVersion(u.orgId);
  const base = `dashboard-home:u${u.userId}:v${version}:${resource}:${scope}`;
  const withDim = dimension ? `${base}:${dimension}` : base;
  return locale ? `${withDim}:${locale}` : withDim;
}

export async function buildOrgDashboardCacheKey(
  access: AccessService,
  orgId: string,
  resource: string,
  dimension?: string,
): Promise<string> {
  const version = await access.getPermissionsVersion(orgId);
  const base = `dashboard-home:v${version}:${resource}`;
  return dimension ? `${base}:${dimension}` : base;
}

/**
 * The typed entry points. The section key selects the namespace from the
 * registry and the registry's `cacheScope` decides which of the two a section
 * may use — passing an "org" section to the scoped builder does not compile.
 */
export async function buildScopedSectionCacheKey(
  access: AccessService,
  u: CurrentUserContext,
  section: ScopedCachedSectionKey,
  scope: DataScope,
  dimension?: string,
  locale?: string,
): Promise<string> {
  return buildScopedDashboardCacheKey(
    access,
    u,
    cacheNamespaceOf(section),
    scope,
    dimension,
    locale,
  );
}

export async function buildOrgSectionCacheKey(
  access: AccessService,
  orgId: string,
  section: OrgCachedSectionKey,
  dimension?: string,
): Promise<string> {
  return buildOrgDashboardCacheKey(access, orgId, cacheNamespaceOf(section), dimension);
}
