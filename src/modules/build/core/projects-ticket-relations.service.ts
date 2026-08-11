import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, or } from "drizzle-orm";
import { projectMembers, tickets, workItemRelations } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { AddRelationInput } from "./dto/projects.schemas";

@Injectable()
export class ProjectsTicketRelationsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async requireMember(
    projectId: number,
    userId: string,
  ): Promise<void> {
    const member = await this.db.query.projectMembers.findFirst({
      where: and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
      ),
    });
    if (!member) throw new ForbiddenException("Not a project member.");
  }

  private async requireProjectTicket(
    orgId: string,
    projectId: number,
    ticketId: number,
  ): Promise<void> {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, ticketId),
        eq(tickets.orgId, orgId),
        eq(tickets.projectId, projectId),
      ),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
  }

  private detectBlockingCycle(
    edges: { workItemId: number; relatedWorkItemId: number; relationType: string }[],
    fromId: number,
    toId: number,
  ): boolean {
    const adj = new Map<number, number[]>();
    for (const edge of edges) {
      const f =
        edge.relationType === "blocks" ? edge.workItemId : edge.relatedWorkItemId;
      const t =
        edge.relationType === "blocks" ? edge.relatedWorkItemId : edge.workItemId;
      const neighbors = adj.get(f) ?? [];
      neighbors.push(t);
      adj.set(f, neighbors);
    }
    const proposed = adj.get(fromId) ?? [];
    proposed.push(toId);
    adj.set(fromId, proposed);
    const visited = new Set<number>();
    const stack = [toId];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) continue;
      if (node === fromId) return true;
      if (visited.has(node)) continue;
      visited.add(node);
      for (const neighbor of adj.get(node) ?? [])
        stack.push(neighbor);
    }
    return false;
  }

  async listRelations(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
  ) {
    await this.requireMember(projectId, u.userId);
    await this.requireProjectTicket(u.orgId, projectId, ticketId);

    const relatedTicketSelect = {
      columns: {
        id: true,
        title: true,
        ticketNumber: true,
        status: true,
        priority: true,
        type: true,
        points: true,
        assigneeId: true,
        projectId: true,
      },
      with: {
        assignee: {
          columns: {
            id: true,
            name: true,
            firstName: true,
            lastName: true,
            email: true,
            image: true,
          },
        },
        project: {
          columns: { key: true },
        },
      },
    } as const;

    const relations = await this.db.query.workItemRelations.findMany({
      where: and(
        eq(workItemRelations.orgId, u.orgId),
        or(
          eq(workItemRelations.workItemId, ticketId),
          eq(workItemRelations.relatedWorkItemId, ticketId),
        ),
      ),
      with: {
        workItem: relatedTicketSelect,
        relatedWorkItem: relatedTicketSelect,
      },
      limit: 100,
    });

    return relations.map((r) => {
      const isSource = r.workItemId === ticketId;
      return {
        id: r.id,
        relationType: r.relationType,
        relatedTicket: isSource ? r.relatedWorkItem : r.workItem,
        direction: isSource ? "outgoing" : "incoming",
      };
    });
  }

  async addRelation(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    body: AddRelationInput,
  ) {
    await this.requireMember(projectId, u.userId);
    await this.requireProjectTicket(u.orgId, projectId, ticketId);

    if (body.relatedTicketId === ticketId) {
      throw new BadRequestException("A ticket cannot relate to itself.");
    }

    const relatedTicket = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, body.relatedTicketId),
        eq(tickets.projectId, projectId),
        eq(tickets.orgId, u.orgId),
      ),
      columns: { id: true },
    });
    if (!relatedTicket)
      throw new NotFoundException("Related ticket not found in this project.");

    if (
      body.relationType === "blocks" ||
      body.relationType === "blocked_by"
    ) {
      const existingEdges = await this.db
        .select({
          workItemId: workItemRelations.workItemId,
          relatedWorkItemId: workItemRelations.relatedWorkItemId,
          relationType: workItemRelations.relationType,
        })
        .from(workItemRelations)
        .innerJoin(
          tickets,
          and(
            eq(tickets.id, workItemRelations.workItemId),
            eq(tickets.projectId, projectId),
            eq(tickets.orgId, u.orgId),
          ),
        )
        .where(
          and(
            eq(workItemRelations.orgId, u.orgId),
            or(
              eq(workItemRelations.relationType, "blocks"),
              eq(workItemRelations.relationType, "blocked_by"),
            ),
          ),
        )
        .limit(1001);

      if (existingEdges.length > 1000)
        throw new BadRequestException(
          "Project dependency graph is too large to validate for cycles",
        );

      const fromId =
        body.relationType === "blocks" ? ticketId : body.relatedTicketId;
      const toId =
        body.relationType === "blocks" ? body.relatedTicketId : ticketId;

      if (this.detectBlockingCycle(existingEdges, fromId, toId))
        throw new BadRequestException(
          "Cannot add this relation: it would create a circular blocking dependency",
        );
    }

    const [created] = await this.db
      .insert(workItemRelations)
      .values({
        orgId: u.orgId,
        workItemId: ticketId,
        relatedWorkItemId: body.relatedTicketId,
        relationType: body.relationType,
      })
      .onConflictDoNothing()
      .returning();

    if (!created) throw new ConflictException("This relation already exists.");

    return created;
  }

  async removeRelation(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    relatedId: number,
  ) {
    await this.requireMember(projectId, u.userId);
    await this.requireProjectTicket(u.orgId, projectId, ticketId);

    if (!relatedId)
      throw new BadRequestException("relatedId query param required.");

    await this.db.delete(workItemRelations).where(
      and(
        eq(workItemRelations.orgId, u.orgId),
        or(
          and(
            eq(workItemRelations.workItemId, ticketId),
            eq(workItemRelations.relatedWorkItemId, relatedId),
          ),
          and(
            eq(workItemRelations.workItemId, relatedId),
            eq(workItemRelations.relatedWorkItemId, ticketId),
          ),
        ),
      ),
    );

    return { success: true };
  }
}
