import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { invProjects } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import type { InventorySettingsService } from "../../stock-engine/inventory-settings.service";
import type { ListProjectsInput } from "../dto/inv-projects.schemas";
import { OPEN_PROJECT_STATUSES } from "../inv-projects.service";
import { assertPack } from "./project-reads";

/**
 * Listing projects, split out of `project-reads.ts` so neither file sits above
 * the 300-line ratchet. Listing is a paged search over the project header;
 * `project-reads.ts` answers about a single project's requirements and cover.
 */
export function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (c) => `\\${c}`);
}

export async function listProjects(
    db: Db,
    settingsService: InventorySettingsService,
    orgId: string,
    filters: ListProjectsInput,
  ) {
    await assertPack(settingsService, orgId);
    const { page, limit } = filters;
    const offset = (page - 1) * limit;

    const conds = [eq(invProjects.orgId, orgId), isNull(invProjects.deletedAt)];
    if (filters.status) conds.push(eq(invProjects.status, filters.status));
    if (filters.openOnly) conds.push(inArray(invProjects.status, [...OPEN_PROJECT_STATUSES]));
    if (filters.zone) conds.push(eq(invProjects.zone, filters.zone));
    if (filters.clientId) conds.push(eq(invProjects.clientId, filters.clientId));
    if (filters.search) {
      const term = `%${escapeLike(filters.search)}%`;
      conds.push(or(ilike(invProjects.name, term), ilike(invProjects.code, term))!);
    }
    const where = and(...conds);

    const [items, countRows] = await Promise.all([
      db
        .select({
          id: invProjects.id,
          code: invProjects.code,
          name: invProjects.name,
          clientId: invProjects.clientId,
          city: invProjects.city,
          zone: invProjects.zone,
          status: invProjects.status,
          startsOn: invProjects.startsOn,
          endsOn: invProjects.endsOn,
          siteContactName: invProjects.siteContactName,
          createdAt: invProjects.createdAt,
          updatedAt: invProjects.updatedAt,
          // One correlated aggregate per project rather than a second round trip
          // per row: the list is the screen a planner scans, and "how many lines
          // are still open" is the number they scan for.
          openRequirements: sql<number>`(
            SELECT count(*)::int FROM inv_project_requirements r
            WHERE r.org_id = ${invProjects.orgId} AND r.project_id = ${invProjects.id}
              AND r.status IN ('DRAFT', 'REQUESTED', 'RESERVED', 'PARTIALLY_FULFILLED')
          )`,
          overdueRequirements: sql<number>`(
            SELECT count(*)::int FROM inv_project_requirements r
            WHERE r.org_id = ${invProjects.orgId} AND r.project_id = ${invProjects.id}
              AND r.status IN ('DRAFT', 'REQUESTED', 'RESERVED', 'PARTIALLY_FULFILLED')
              AND r.required_by IS NOT NULL AND r.required_by < CURRENT_DATE
          )`,
        })
        .from(invProjects)
        .where(where)
        .orderBy(desc(invProjects.updatedAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(invProjects).where(where),
    ]);

    const total = countRows[0]?.count ?? 0;
    return { items, total, page, totalPages: Math.ceil(total / limit) };
  }
