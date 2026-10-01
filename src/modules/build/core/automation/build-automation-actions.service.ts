import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  projectAutomations,
  projectStatuses,
  ticketComments,
  ticketLabelMappings,
  ticketLabels,
  tickets,
  organizationMembers,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { logger } from "../../../../common/logger/logger.service";
import { reserveTicketCapacity } from "../lib/build-ticket-capacity";
import { assertTransitionAllowed } from "../tickets/projects-tickets-workflow-utils";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import { ProjectsActivityService } from "../activity/projects-activity.service";

export type StoredAction = NonNullable<typeof projectAutomations.$inferSelect>["actions"][number];

function isTicketPriority(value: string): value is "LOW" | "MEDIUM" | "HIGH" | "URGENT" {
  return value === "LOW" || value === "MEDIUM" || value === "HIGH" || value === "URGENT";
}

function isValidLabelId(value: string): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

@Injectable()
export class BuildAutomationActionExecutor {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly activity: ProjectsActivityService,
  ) {}

  private async applyLabel(orgId: string, ticketId: number, labelRef: string): Promise<boolean> {
    if (isValidLabelId(labelRef)) {
      const numericId = Number(labelRef);
      const found = await this.db.query.ticketLabels.findFirst({
        where: and(eq(ticketLabels.id, numericId), eq(ticketLabels.orgId, orgId)),
        columns: { id: true },
      });
      if (!found) {
        logger.warn("BuildAutomationActionExecutor: label not found by id", { numericId, orgId });
        return false;
      }
      await this.db
        .insert(ticketLabelMappings)
        .values({ orgId, ticketId, labelId: found.id })
        .onConflictDoNothing();
      return true;
    }

    const byName = await this.db.query.ticketLabels.findFirst({
      where: and(eq(ticketLabels.name, labelRef), eq(ticketLabels.orgId, orgId)),
      columns: { id: true },
    });
    if (!byName) {
      logger.warn("BuildAutomationActionExecutor: label not found by name", { labelRef, orgId });
      return false;
    }
    await this.db
      .insert(ticketLabelMappings)
      .values({ orgId, ticketId, labelId: byName.id })
      .onConflictDoNothing();
    return true;
  }

  async execute(
    orgId: string,
    projectId: number,
    ticketId: number,
    ruleId: number,
    action: StoredAction,
    authorId: string | null,
  ): Promise<void> {
    const ticketWhere = and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId), eq(tickets.projectId, projectId), isNull(tickets.deletedAt));
    switch (action.type) {
      case "set_status": {
        const statusExists = await this.db.query.projectStatuses.findFirst({
          where: and(
            eq(projectStatuses.orgId, orgId),
            eq(projectStatuses.projectId, projectId),
            eq(projectStatuses.name, action.value),
          ),
          columns: { id: true },
        });
        if (!statusExists) {
          logger.warn("BuildAutomationActionExecutor: set_status skipped — status does not exist in project", {
            ruleId,
            projectId,
            orgId,
            status: action.value,
          });
          return;
        }
        const currentTicket = await this.db.query.tickets.findFirst({
          where: and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)),
          columns: { status: true, version: true },
        });
        if (!currentTicket) return;
        const previousStatus = currentTicket.status;
        const now = new Date();
        await this.db.transaction(async tx => {
          await assertTransitionAllowed(tx, orgId, projectId, previousStatus, action.value, {
            userId: authorId ?? "automation",
            userProjectRole: null,
            isOrgOwner: false,
            ticketId,
          });
          await reserveTicketCapacity(tx, orgId, projectId, [{ status: action.value, count: 1 }], [ticketId]);
          const rows = await tx.update(tickets)
            .set({ status: action.value, updatedAt: now, version: currentTicket.version + 1 })
            .where(ticketWhere)
            .returning({ version: tickets.version });
          const updatedVersion = rows[0]?.version ?? currentTicket.version + 1;
          await OutboxWriter.emit(tx, {
            eventId: randomUUID(),
            organizationId: orgId,
            aggregateType: "ticket",
            aggregateId: String(ticketId),
            aggregateVersion: updatedVersion,
            eventType: "build.ticket.status_changed",
            occurredAt: now,
            payload: {
              ticketId,
              projectId,
              orgId,
              previousStatus,
              newStatus: action.value,
              actorUserId: authorId ?? null,
            },
          });
        });
        await this.activity.logTicketActivity(orgId, ticketId, authorId, "status_changed", previousStatus, action.value);
        return;
      }
      case "set_assignee": {
        await this.db
          .update(tickets)
          .set({
            assigneeMembershipId: (await this.db.query.organizationMembers.findFirst({
              where: and(
                eq(organizationMembers.orgId, orgId),
                eq(organizationMembers.userId, action.value),
                eq(organizationMembers.status, "ACTIVE"),
              ),
              columns: { id: true },
            }))?.id ?? null,
            updatedAt: new Date(),
          })
          .where(ticketWhere);
        await this.activity.logTicketActivity(orgId, ticketId, authorId, "assignee_changed");
        return;
      }
      case "set_priority": {
        if (!isTicketPriority(action.value)) {
          logger.warn("BuildAutomationActionExecutor: invalid priority value, skipping", {
            value: action.value,
            ticketId,
          });
          return;
        }
        await this.db
          .update(tickets)
          .set({ priority: action.value, updatedAt: new Date() })
          .where(ticketWhere);
        await this.activity.logTicketActivity(orgId, ticketId, authorId, "priority_changed");
        return;
      }
      case "add_label": {
        const applied = await this.applyLabel(orgId, ticketId, action.value);
        if (applied) {
          await this.activity.logTicketActivity(orgId, ticketId, authorId, "label_changed");
        }
        return;
      }
      case "add_comment": {
        if (!authorId) {
          logger.warn("BuildAutomationActionExecutor: add_comment skipped, automation has no authorId", {
            ticketId,
          });
          return;
        }
        await this.db
          .insert(ticketComments)
          .values({ orgId, ticketId, userId: authorId, content: action.value });
        await this.activity.logTicketActivity(orgId, ticketId, authorId, "comment_added");
        return;
      }
    }
  }
}
