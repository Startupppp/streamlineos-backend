import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, or } from "drizzle-orm";
import { tickets, workItemRelations } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { AccessService } from "../../../access/access.service";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import { BUILD_BLOCKER_CREATED_EVENT } from "./build-blocker-created-consumer.service";
import { assertTicketReadAccess, type TicketReadAccess, assertTicketWriteAccess } from "../project-crud/project-access";
import type { AddRelationInput } from "../dto/projects.schemas";

@Injectable()
export class ProjectsTicketRelationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(AccessService) private readonly access: TicketReadAccess,
  ) {}

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
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);

    const relatedTicketSelect = {
      where: isNull(tickets.deletedAt),
      columns: {
        id: true,
        title: true,
        ticketNumber: true,
        status: true,
        priority: true,
        type: true,
        points: true,
        version: true,
        assigneeMembershipId: true,
        projectId: true,
      },
      with: {
        assignee: {
          with: {
            user: {
              columns: {
                id: true,
                name: true,
                firstName: true,
                lastName: true,
                email: true,
                image: true,
              },
            },
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

    return relations.flatMap((r) => {
      const isSource = r.workItemId === ticketId;
      const related = isSource ? r.relatedWorkItem : r.workItem;
      if (related === null) return [];
      const { assignee, ...rest } = related;
      return [
        {
          id: r.id,
          relationType: r.relationType,
          relatedTicket: { ...rest, assignee: assignee?.user ?? null },
          direction: isSource ? "outgoing" : "incoming",
        },
      ];
    });
  }

  async addRelation(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    body: AddRelationInput,
  ) {
    await assertTicketWriteAccess(this.db, this.access, u, projectId, ticketId);

    if (body.relatedTicketId === ticketId) {
      throw new BadRequestException("A ticket cannot relate to itself.");
    }

    const relatedTicket = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, body.relatedTicketId),
        eq(tickets.projectId, projectId),
        eq(tickets.orgId, u.orgId),
        isNull(tickets.deletedAt),
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
            isNull(tickets.deletedAt),
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

    const isBlocker =
      body.relationType === "blocks" || body.relationType === "blocked_by";

    const created = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(workItemRelations)
        .values({
          orgId: u.orgId,
          workItemId: ticketId,
          relatedWorkItemId: body.relatedTicketId,
          relationType: body.relationType,
        })
        .onConflictDoNothing()
        .returning();

      if (!row) return null;

      if (isBlocker)
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: u.orgId,
          aggregateType: "work_item_relation",
          aggregateId: String(row.id),
          aggregateVersion: 1,
          eventType: BUILD_BLOCKER_CREATED_EVENT,
          occurredAt: new Date(),
          payload: {
            relationId: row.id,
            blockedTicketId:
              body.relationType === "blocks" ? body.relatedTicketId : ticketId,
            blockingTicketId:
              body.relationType === "blocks" ? ticketId : body.relatedTicketId,
            projectId,
            orgId: u.orgId,
            actorUserId: u.userId,
          },
        });

      return row;
    });

    if (!created) throw new ConflictException("This relation already exists.");

    return created;
  }

  async removeRelation(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    relatedId: number,
  ) {
    await assertTicketWriteAccess(this.db, this.access, u, projectId, ticketId);

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
