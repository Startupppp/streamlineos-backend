import { GoneException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { cycles, sprints, tickets } from "../../../db/schema";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreateSprintInput, UpdateSprintInput } from "./dto/iterations.schemas";
import { ProjectsWebhooksDispatchService } from "../core/projects-webhooks-dispatch.service";
import { assertProjectInOrg } from "../core/project-access";

@Injectable()
export class SprintsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Optional() private readonly webhooksDispatch: ProjectsWebhooksDispatchService | null,
  ) {}

  async listSprints(orgId: string, projectId: number) {
    await assertProjectInOrg(this.db, orgId, projectId);
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
    const cycleRows = await this.db
      .select({ id: cycles.id, legacySprintId: cycles.legacySprintId })
      .from(cycles)
      .where(and(eq(cycles.orgId, orgId), inArray(cycles.legacySprintId, sprintIds)))
      .limit(sprintIds.length * 2);
    const sprintToCycle = new Map(
      cycleRows.filter((r) => r.legacySprintId !== null).map((r) => [r.legacySprintId!, r.id]),
    );
    const cycleIds = cycleRows.map((r) => r.id);

    const ticketRows = cycleIds.length
      ? await this.db
          .select({
            id: tickets.id,
            title: tickets.title,
            status: tickets.status,
            points: tickets.points,
            cycleId: tickets.cycleId,
          })
          .from(tickets)
          .where(and(eq(tickets.orgId, orgId), isNull(tickets.deletedAt), inArray(tickets.cycleId, cycleIds)))
          .limit(500)
      : [];

    const ticketsByCycleId = new Map<number, typeof ticketRows>();
    for (const ticket of ticketRows) {
      if (ticket.cycleId === null) continue;
      const existing = ticketsByCycleId.get(ticket.cycleId) ?? [];
      existing.push(ticket);
      ticketsByCycleId.set(ticket.cycleId, existing);
    }

    return sprintList.map((sprint) => {
      const cycleId = sprintToCycle.get(sprint.id);
      return { ...sprint, tickets: cycleId !== undefined ? ticketsByCycleId.get(cycleId) ?? [] : [] };
    });
  }

  async createSprint(_orgId: string, _projectId: number, _input: CreateSprintInput): Promise<never> {
    throw new GoneException(
      "Sprint creation is frozen. Create a Cycle via POST /build/:projectId/cycles to start a new iteration.",
    );
  }

  async getSprint(orgId: string, projectId: number, sprintId: number) {
    const sprint = await this.db.query.sprints.findFirst({
      where: and(eq(sprints.id, sprintId), eq(sprints.projectId, projectId), eq(sprints.orgId, orgId), isNull(sprints.deletedAt)),
      with: {
        tickets: {
          where: isNull(tickets.deletedAt),
          limit: 200,
          with: {
            assignee: { with: { user: { columns: { id: true, name: true, firstName: true, lastName: true, image: true, email: true } } } },
          },
        },
      },
    });
    if (!sprint) throw new NotFoundException("Sprint not found");
    return sprint;
  }

  async updateSprint(orgId: string, projectId: number, sprintId: number, input: UpdateSprintInput, actorId?: string) {
    const before = await this.db.query.sprints.findFirst({
      where: and(eq(sprints.id, sprintId), eq(sprints.projectId, projectId), eq(sprints.orgId, orgId), isNull(sprints.deletedAt)),
      columns: { id: true, name: true, status: true, projectId: true },
    });
    if (!before) throw new NotFoundException("Sprint not found");

    await this.db.transaction(async (tx) => {
      const changed = await tx
        .update(sprints)
        .set({
          ...(input.name && { name: input.name }),
          ...(input.startDate && { startDate: new Date(input.startDate) }),
          ...(input.endDate && { endDate: new Date(input.endDate) }),
          ...(input.goal !== undefined && { goal: input.goal }),
          ...(input.status && { status: input.status }),
        })
        .where(and(eq(sprints.id, sprintId), eq(sprints.orgId, orgId), isNull(sprints.deletedAt)))
        .returning({ id: sprints.id });
      if (changed.length === 0) throw new NotFoundException("Sprint not found");

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

      if (before && input.status && input.status !== before.status && this.webhooksDispatch) {
        const eventName = input.status === "ACTIVE"
          ? "sprint.started"
          : input.status === "COMPLETED"
            ? "sprint.completed"
            : null;
        if (eventName) {
          await this.webhooksDispatch.enqueue(tx, orgId, before.projectId, eventName, {
            id: sprintId,
            projectId: before.projectId,
            name: input.name ?? before.name,
            status: input.status,
            actor: actorId ?? "system",
            timestamp: new Date().toISOString(),
          });
        }
      }
    });

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
