import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  projectAutomations,
  projectStatuses,
  ticketComments,
  ticketLabelMappings,
  ticketLabels,
  tickets,
  organizationMembers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import { reserveTicketCapacity } from "./build-ticket-capacity";

export type StoredAction = NonNullable<typeof projectAutomations.$inferSelect>["actions"][number];

function isTicketPriority(value: string): value is "LOW" | "MEDIUM" | "HIGH" | "URGENT" {
  return value === "LOW" || value === "MEDIUM" || value === "HIGH" || value === "URGENT";
}

function isValidLabelId(value: string): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

/**
 * Executes one automation action against one ticket. Split out of
 * `BuildAutomationRunnerService` (BE-09): the runner decides *whether* an
 * action set should run (conditions, loop guard, rate limit, history); this
 * decides *how* one action mutates a ticket. Every write here goes straight
 * to `tickets`/`ticketLabelMappings`/`ticketComments` via Drizzle rather than
 * through `ProjectsTicketsUpdateService` — see the loop-prevention note on
 * `BuildAutomationRunnerService` for why that matters.
 */
@Injectable()
export class BuildAutomationActionExecutor {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async applyLabel(orgId: string, ticketId: number, labelRef: string): Promise<void> {
    if (isValidLabelId(labelRef)) {
      const numericId = Number(labelRef);
      const found = await this.db.query.ticketLabels.findFirst({
        where: and(eq(ticketLabels.id, numericId), eq(ticketLabels.orgId, orgId)),
        columns: { id: true },
      });
      if (!found) {
        logger.warn("BuildAutomationActionExecutor: label not found by id", { numericId, orgId });
        return;
      }
      await this.db
        .insert(ticketLabelMappings)
        .values({ orgId, ticketId, labelId: found.id })
        .onConflictDoNothing();
      return;
    }

    const byName = await this.db.query.ticketLabels.findFirst({
      where: and(eq(ticketLabels.name, labelRef), eq(ticketLabels.orgId, orgId)),
      columns: { id: true },
    });
    if (!byName) {
      logger.warn("BuildAutomationActionExecutor: label not found by name", { labelRef, orgId });
      return;
    }
    await this.db
      .insert(ticketLabelMappings)
      .values({ orgId, ticketId, labelId: byName.id })
      .onConflictDoNothing();
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
        await this.db.transaction(async tx => {
          await reserveTicketCapacity(tx, orgId, projectId, [{ status: action.value, count: 1 }], [ticketId]);
          await tx.update(tickets)
            .set({ status: action.value, updatedAt: new Date(), version: sql`${tickets.version} + 1` })
            .where(ticketWhere);
        });
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
        return;
      }
      case "add_label": {
        await this.applyLabel(orgId, ticketId, action.value);
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
        return;
      }
    }
  }
}
