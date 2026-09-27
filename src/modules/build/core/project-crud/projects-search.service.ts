import { Inject, Injectable } from "@nestjs/common";
import { and, eq, exists, isNull, or, sql } from "drizzle-orm";
import { organizationMembers, projectMembers, projects, tickets } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";

/**
 * The caller's project membership is a correlated EXISTS, not a materialised id list.
 *
 * Reading every `project_members` row for the caller and feeding the whole array
 * into `inArray` is unbounded in the number of projects one person belongs to, and
 * the array crossed the wire twice — once out of Postgres, once back in as bind
 * parameters. EXISTS lets the planner stop at the first matching membership row per
 * ticket and keeps the whole search to a single round trip.
 *
 * `projects` is joined on (id, org_id), not id alone: `tickets.project_id` and
 * `projects.id` are both org-local integer keys, so an id-only join states no tenant
 * predicate on the joined side and depends entirely on RLS to keep another org's
 * project name and key out of the row.
 *
 * The `LIMIT 1` inside the EXISTS is redundant to Postgres, which short-circuits an
 * EXISTS on the first matching row regardless. It is there so the read is bounded in
 * the text as well as in the plan: `check-unbounded-reads.mjs` reads a statement and
 * looks for `.limit(`, so without it this file keeps a FALSE-POSITIVE suppression row
 * standing over code that no longer needs one.
 */
export function orgTicketSearchQuery(
  db: Db,
  orgId: string,
  userId: string,
  q: string,
  limit: number,
) {
  const callerIsProjectMember = exists(
    db
      .select({ present: sql`1` })
      .from(projectMembers)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.id, projectMembers.membershipId),
          eq(organizationMembers.orgId, projectMembers.orgId),
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .where(
        and(
          eq(projectMembers.orgId, orgId),
          eq(projectMembers.projectId, tickets.projectId),
        ),
      )
      .limit(1),
  );

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
      and(eq(tickets.projectId, projects.id), eq(projects.orgId, tickets.orgId)),
    )
    .where(
      and(
        eq(tickets.orgId, orgId),
        callerIsProjectMember,
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
    .orderBy(sql`${tickets.updatedAt} DESC`)
    .limit(limit);
}

@Injectable()
export class ProjectsSearchService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async searchOrgTickets(orgId: string, userId: string, q: string, limit: number) {
    return orgTicketSearchQuery(this.db, orgId, userId, q, limit);
  }
}
