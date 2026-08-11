import { Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { sprints, tickets } from "../../../db/schema";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreateSprintInput, UpdateSprintInput } from "./dto/iterations.schemas";
import { ProjectsWebhooksDispatchService } from "../../build/core/projects-webhooks-dispatch.service";

@Injectable()
export class SprintsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Optional() private readonly webhooksDispatch: ProjectsWebhooksDispatchService | null,
  ) {}

  async listSprints(orgId: string, projectId: number) {
    const sprintList = await this.db
      .select({
        id: sprints.id,
        orgId: sprints.orgId,
        projectId: sprints.projectId,
        name: sprints.name,
        startDate: sprints.startDate,
        endDate: sprints.endDate,
        goal: sprints.goal,
        status: sprints.status,
      })
      .from(sprints)
      .where(and(eq(sprints.orgId, orgId), eq(sprints.projectId, projectId), isNull(sprints.deletedAt)))
      .orderBy(desc(sprints.startDate))
      .limit(100);

    if (sprintList.length === 0) return [];

    const sprintIds = sprintList.map((s) => s.id);
    const ticketRows = await this.db
      .select({
        id: tickets.id,
        title: tickets.title,
        status: tickets.status,
        points: tickets.points,
        sprintId: tickets.sprintId,
      })
      .from(tickets)
      .where(and(eq(tickets.orgId, orgId), isNull(tickets.deletedAt), inArray(tickets.sprintId, sprintIds)))
      .limit(500);

    const ticketsBySprintId = new Map<number, typeof ticketRows>();
    for (const ticket of ticketRows) {
      if (ticket.sprintId === null) continue;
      const existing = ticketsBySprintId.get(ticket.sprintId);
      if (existing)
        existing.push(ticket);
      else
        ticketsBySprintId.set(ticket.sprintId, [ticket]);
    }

    return sprintList.map((sprint) => ({
      ...sprint,
      tickets: ticketsBySprintId.get(sprint.id) ?? [],
    }));
  }

  async createSprint(orgId: string, projectId: number, input: CreateSprintInput) {
    const [sprint] = await this.db
      .insert(sprints)
      .values({
        orgId,
        projectId,
        name: input.name,
        startDate: new Date(input.startDate),
        endDate: new Date(input.endDate),
        goal: input.goal,
        status: "PLANNED",
      })
      .returning();

    return sprint;
  }

  async getSprint(orgId: string, sprintId: number) {
    const sprint = await this.db.query.sprints.findFirst({
      where: and(eq(sprints.id, sprintId), eq(sprints.orgId, orgId), isNull(sprints.deletedAt)),
      with: {
        tickets: {
          where: isNull(tickets.deletedAt),
          limit: 200,
          with: {
            assignee: {
              columns: { id: true, name: true, firstName: true, lastName: true, image: true, email: true },
            },
          },
        },
      },
    });
    if (!sprint) throw new NotFoundException("Sprint not found");
    return sprint;
  }

  async updateSprint(orgId: string, sprintId: number, input: UpdateSprintInput, actorId?: string) {
    const before = await this.db.query.sprints.findFirst({
      where: and(eq(sprints.id, sprintId), eq(sprints.orgId, orgId), isNull(sprints.deletedAt)),
      columns: { id: true, name: true, status: true, projectId: true },
    });

    await this.db.transaction(async (tx) => {
      await tx
        .update(sprints)
        .set({
          ...(input.name && { name: input.name }),
          ...(input.startDate && { startDate: new Date(input.startDate) }),
          ...(input.endDate && { endDate: new Date(input.endDate) }),
          ...(input.goal !== undefined && { goal: input.goal }),
          ...(input.status && { status: input.status }),
        })
        .where(and(eq(sprints.id, sprintId), eq(sprints.orgId, orgId)));

      if (before && input.status === "COMPLETED" && before.status !== "COMPLETED") {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "sprint",
          aggregateId: String(sprintId),
          aggregateVersion: Date.now(),
          eventType: "build.sprint.completed",
          payload: {
            sprintId,
            projectId: before.projectId,
            orgId,
            name: input.name ?? before.name,
            actorUserId: actorId ?? null,
          },
          occurredAt: new Date(),
        });
      }
    });

    if (before && input.status && input.status !== before.status && this.webhooksDispatch) {
      const eventName =
        input.status === "ACTIVE"
          ? "sprint.started"
          : input.status === "COMPLETED"
            ? "sprint.completed"
            : null;
      if (eventName) {
        this.webhooksDispatch.dispatch(orgId, before.projectId, eventName, {
          id: sprintId,
          projectId: before.projectId,
          name: input.name ?? before.name,
          status: input.status,
          actor: actorId ?? "system",
          timestamp: new Date().toISOString(),
        });
      }
    }

    return { success: true };
  }

  async deleteSprint(orgId: string, projectId: number, sprintId: number) {
    const sprint = await this.db.query.sprints.findFirst({
      where: and(eq(sprints.id, sprintId), eq(sprints.orgId, orgId), eq(sprints.projectId, projectId), isNull(sprints.deletedAt)),
      columns: { id: true },
    });
    if (!sprint) throw new NotFoundException("Sprint not found");
    await this.db.update(sprints).set({ deletedAt: new Date() }).where(and(eq(sprints.id, sprintId), eq(sprints.orgId, orgId)));
    return { success: true };
  }
}
