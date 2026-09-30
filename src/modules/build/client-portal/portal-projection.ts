import { and, eq, isNull, sql } from "drizzle-orm";
import {
  projectMilestones,
  ticketAttachments,
  ticketComments,
  tickets,
  users,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";

export type PortalCapabilities = {
  canViewMilestones: boolean;
  canViewTasks: boolean;
  canViewAttachments: boolean;
  canViewComments: boolean;
};

export async function buildPortalProjection(
  db: Db,
  orgId: string,
  projectId: number,
  capabilities: PortalCapabilities,
) {
  const [milestones, tasks, attachments, comments] = await Promise.all([
    capabilities.canViewMilestones
      ? db
          .select({
            id: projectMilestones.id,
            name: projectMilestones.name,
            dueDate: projectMilestones.targetDate,
            status: projectMilestones.status,
          })
          .from(projectMilestones)
          .where(
            and(
              eq(projectMilestones.orgId, orgId),
              eq(projectMilestones.projectId, projectId),
              eq(projectMilestones.clientVisible, true),
              isNull(projectMilestones.deletedAt),
            ),
          )
          .limit(100)
      : Promise.resolve([]),

    capabilities.canViewTasks
      ? db
          .select({
            id: tickets.id,
            ticketNumber: tickets.ticketNumber,
            title: tickets.title,
            status: tickets.status,
            dueDate: tickets.dueDate,
          })
          .from(tickets)
          .where(
            and(
              eq(tickets.orgId, orgId),
              eq(tickets.projectId, projectId),
              eq(tickets.clientVisible, true),
              isNull(tickets.deletedAt),
            ),
          )
          .limit(100)
      : Promise.resolve([]),

    capabilities.canViewAttachments
      ? db
          .select({
            id: ticketAttachments.id,
            filename: ticketAttachments.fileName,
            url: ticketAttachments.fileUrl,
          })
          .from(ticketAttachments)
          .innerJoin(
            tickets,
            and(
              eq(tickets.id, ticketAttachments.ticketId),
              eq(tickets.projectId, projectId),
              eq(tickets.orgId, orgId),
              isNull(tickets.deletedAt),
              eq(tickets.clientVisible, true),
            ),
          )
          .where(
            and(
              eq(ticketAttachments.orgId, orgId),
              eq(ticketAttachments.clientVisible, true),
            ),
          )
          .limit(100)
      : Promise.resolve([]),

    capabilities.canViewComments
      ? db
          .select({
            id: ticketComments.id,
            body: ticketComments.content,
            authorName: sql<string>`COALESCE(${users.name}, ${users.email}, 'Unknown')`,
            createdAt: ticketComments.createdAt,
          })
          .from(ticketComments)
          .innerJoin(
            tickets,
            and(
              eq(tickets.id, ticketComments.ticketId),
              eq(tickets.projectId, projectId),
              eq(tickets.orgId, orgId),
              isNull(tickets.deletedAt),
              eq(tickets.clientVisible, true),
            ),
          )
          .leftJoin(users, eq(users.id, ticketComments.userId))
          .where(
            and(
              eq(ticketComments.orgId, orgId),
              eq(ticketComments.clientVisible, true),
              isNull(ticketComments.deletedAt),
            ),
          )
          .limit(100)
      : Promise.resolve([]),
  ]);

  return { milestones, tasks, attachments, comments };
}
