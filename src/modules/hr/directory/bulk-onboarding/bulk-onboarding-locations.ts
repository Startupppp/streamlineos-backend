import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { orgUnits } from "../../../../db/schema";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";
import { HR_SCAN_MAX_PAGES, HR_SCAN_PAGE } from "../../hr-read-limits";
import type { BulkOnboardEmployeeRow } from "../dto/hr-directory.schemas";

/**
 * BUG-HRMS-006. The org's work locations, resolvable by the three things an
 * uploader might put in the column: the name, the code, or the id.
 *
 * Departments got this treatment already (`bulk-onboarding-departments`), which
 * is why a CSV could name "Engineering" but not "Hyderabad Office". Unlike
 * departments, a location named in a file is NEVER created implicitly — a typo
 * that silently invents an office is worse than a rejected row.
 */
export interface LocationCatalog {
  /** Lower-cased location name or code → org unit id. */
  byKey: Map<string, string>;
  /** Ids of the org's live, non-archived LOCATION units. */
  activeIds: Set<string>;
}

/** One bounded keyset drain of the org's live locations, before any row is processed. */
export async function loadLocationCatalog(
  db: DbOrTx,
  orgId: string,
): Promise<LocationCatalog> {
  const catalog: LocationCatalog = { byKey: new Map(), activeIds: new Set() };

  let afterOrgUnitId = "";
  for (let page = 0; page < HR_SCAN_MAX_PAGES; page++) {
    const chunk = await db
      .select({ id: orgUnits.id, name: orgUnits.name, code: orgUnits.code })
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "LOCATION"),
          isNull(orgUnits.deletedAt),
          sql`${orgUnits.status} <> 'ARCHIVED'`,
          gt(orgUnits.id, afterOrgUnitId),
        ),
      )
      .orderBy(asc(orgUnits.id))
      .limit(HR_SCAN_PAGE);
    if (chunk.length === 0) break;
    for (const location of chunk) {
      catalog.activeIds.add(location.id);
      catalog.byKey.set(location.name.trim().toLowerCase(), location.id);
      if (location.code) catalog.byKey.set(location.code.trim().toLowerCase(), location.id);
    }
    if (chunk.length < HR_SCAN_PAGE) break;
    afterOrgUnitId = chunk[chunk.length - 1].id;
  }

  return catalog;
}

const UNKNOWN_LOCATION_ADVICE =
  "Create it under Organization → Locations first.";

export function resolveLocation(
  row: Pick<BulkOnboardEmployeeRow, "locationId" | "location">,
  catalog: LocationCatalog,
): { locationId: string | null } | { error: string } {
  const explicitId = row.locationId?.trim();
  if (explicitId) {
    if (!catalog.activeIds.has(explicitId))
      return { error: `Unknown work location. ${UNKNOWN_LOCATION_ADVICE}` };
    return { locationId: explicitId };
  }
  const named = row.location?.trim();
  if (!named) return { locationId: null };
  const resolved = catalog.byKey.get(named.toLowerCase());
  if (!resolved) return { error: `Unknown work location "${named}". ${UNKNOWN_LOCATION_ADVICE}` };
  return { locationId: resolved };
}
