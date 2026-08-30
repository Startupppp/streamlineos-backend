import { NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { projects, tickets } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";

export async function assertProject(db: Db, orgId: string, projectId: number) {
  const [project] = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)))
    .limit(1);
  if (!project) throw new NotFoundException("Project not found");
  return project;
}

export async function assertTicket(db: Db, orgId: string, projectId: number, ticketId: number) {
  const [ticket] = await db
    .select({
      id: tickets.id,
      title: tickets.title,
      description: tickets.description,
      type: tickets.type,
      status: tickets.status,
      priority: tickets.priority,
      projectId: tickets.projectId,
    })
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)))
    .limit(1);

  if (!ticket || ticket.projectId !== projectId) throw new NotFoundException("Ticket not found");
  return ticket;
}
