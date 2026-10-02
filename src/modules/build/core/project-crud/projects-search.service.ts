import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { organizationMembers, projects, tickets } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { reachableTicketProjectsSql } from "../../reachability/project-reachability";

export function orgTicketSearchQuery(
  db: Db,
  orgId: string,
  membershipId: number | null,
  q: string,
  limit: number,
) {
  const reachability = membershipId !== null
    ? reachableTicketProjectsSql(orgId, membershipId)
    : sql`false`;

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
        reachability,
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
    .orderBy(
      sql`CASE WHEN UPPER(CONCAT(${projects.key}, '-', CAST(${tickets.ticketNumber} AS TEXT))) = UPPER(${q}) THEN 0 ELSE 1 END`,
      sql`${tickets.updatedAt} DESC`,
    )
    .limit(limit);
}

@Injectable()
export class ProjectsSearchService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async searchOrgTickets(orgId: string, userId: string, q: string, limit: number) {
    const [memberRow] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .limit(1);
    return orgTicketSearchQuery(this.db, orgId, memberRow?.id ?? null, q, limit);
  }
}
