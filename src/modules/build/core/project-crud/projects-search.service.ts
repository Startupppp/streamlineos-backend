import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { projects, tickets } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { AccessService } from "../../../access/access.service";
import { resolveTicketVisibility } from "./project-access";

/**
 * `projects` is joined on (id, org_id), not id alone: `tickets.project_id` and
 * `projects.id` are both org-local integer keys, so an id-only join states no tenant
 * predicate on the joined side and depends entirely on RLS to keep another org's
 * project name and key out of the row.
 */
export function orgTicketSearchQuery(
  db: Db,
  orgId: string,
  visible: SQL,
  q: string,
  limit: number,
) {
  return db
    .select({
      id: tickets.id,
      title: tickets.title,
      status: tickets.status,
      priority: tickets.priority,
      ticketNumber: tickets.ticketNumber,
      projectId: tickets.projectId,
      projectKey: projects.key,
      projectName: projects.name,
    })
    .from(tickets)
    .innerJoin(
      projects,
      and(
        eq(tickets.projectId, projects.id),
        eq(projects.orgId, tickets.orgId),
        isNull(projects.deletedAt),
      ),
    )
    .where(
      and(
        eq(tickets.orgId, orgId),
        visible,
        isNull(tickets.deletedAt),
        q.length > 0
          ? or(
              sql`${tickets.title} ILIKE ${"%" + q + "%"}`,
              sql`CAST(${tickets.ticketNumber} AS TEXT) ILIKE ${"%" + q + "%"}`,
              sql`CONCAT(${projects.key}, '-', CAST(${tickets.ticketNumber} AS TEXT)) ILIKE ${"%" + q + "%"}`,
            )
          : undefined,
      ),
    )
    // An exact key ("ACP-52") ranks first, so a chat key link resolves even when
    // ACP-520..529 and title matches would otherwise fill the page.
    .orderBy(
      sql`CASE WHEN UPPER(CONCAT(${projects.key}, '-', CAST(${tickets.ticketNumber} AS TEXT))) = UPPER(${q}) THEN 0 ELSE 1 END`,
      sql`${tickets.updatedAt} DESC`,
    )
    .limit(limit);
}

@Injectable()
export class ProjectsSearchService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async searchOrgTickets(u: CurrentUserContext, q: string, limit: number) {
    const visible = await resolveTicketVisibility(this.access, u);
    return orgTicketSearchQuery(this.db, u.orgId, visible, q, limit);
  }
}
