import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  projectAutomations,
  ticketComments,
  ticketLabelMappings,
  ticketLabels,
  tickets,
  organizationMembers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import {
  evaluateNormalizedCondition,
  type ConditionOp,
  type NormalizedCondition,
} from "../../automation/shared-condition-evaluator";

type StoredCondition = NonNullable<typeof projectAutomations.$inferSelect>["conditions"][number];
type StoredAction = NonNullable<typeof projectAutomations.$inferSelect>["actions"][number];

export interface TicketEventPayload {
  ticketId: number;
  projectId: number;
  orgId: string;
  status?: string;
  priority?: string;
  assigneeId?: string | null;
  title?: string;
  type?: string;
}

const BUILD_OP_MAP: Record<
  Exclude<StoredCondition["operator"], "is_empty" | "is_not_empty">,
  ConditionOp
> = {
  equals: "eq",
  not_equals: "neq",
  contains: "contains",
};

function evaluateBuildCondition(
  condition: StoredCondition,
  payload: Record<string, unknown>,
): boolean {
  if (condition.operator === "is_empty") {
    return !evaluateNormalizedCondition({ field: condition.field, op: "exists" }, payload);
  }
  if (condition.operator === "is_not_empty") {
    return evaluateNormalizedCondition({ field: condition.field, op: "exists" }, payload);
  }
  const normalized: NormalizedCondition = {
    field: condition.field,
    op: BUILD_OP_MAP[condition.operator],
    value: condition.value,
  };
  return evaluateNormalizedCondition(normalized, payload);
}

function evaluateBuildConditions(
  conditions: StoredCondition[],
  payload: Record<string, unknown>,
): boolean {
  if (conditions.length === 0) return true;
  return conditions.every((c) => evaluateBuildCondition(c, payload));
}

function isTicketPriority(value: string): value is "LOW" | "MEDIUM" | "HIGH" | "URGENT" {
  return value === "LOW" || value === "MEDIUM" || value === "HIGH" || value === "URGENT";
}

function isValidLabelId(value: string): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

@Injectable()
export class BuildAutomationRunnerService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async applyLabel(orgId: string, ticketId: number, labelRef: string): Promise<void> {
    if (isValidLabelId(labelRef)) {
      const numericId = Number(labelRef);
      const found = await this.db.query.ticketLabels.findFirst({
        where: and(eq(ticketLabels.id, numericId), eq(ticketLabels.orgId, orgId)),
        columns: { id: true },
      });
      if (!found) {
        logger.warn("BuildAutomationRunner: label not found by id", { numericId, orgId });
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
      logger.warn("BuildAutomationRunner: label not found by name", { labelRef, orgId });
      return;
    }
    await this.db
      .insert(ticketLabelMappings)
      .values({ orgId, ticketId, labelId: byName.id })
      .onConflictDoNothing();
  }

  private async executeAction(
    orgId: string,
    ticketId: number,
    action: StoredAction,
    authorId: string | null,
  ): Promise<void> {
    const ticketWhere = and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId));
    switch (action.type) {
      case "set_status": {
        await this.db
          .update(tickets)
          .set({ status: action.value, updatedAt: new Date() })
          .where(ticketWhere);
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
          logger.warn("BuildAutomationRunner: invalid priority value, skipping", {
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
          logger.warn("BuildAutomationRunner: add_comment skipped, automation has no authorId", {
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

  private async execute(
    orgId: string,
    projectId: number,
    triggerEvent: string,
    ticket: TicketEventPayload,
  ): Promise<void> {
    const rules = await this.db
      .select({
        id: projectAutomations.id,
        conditions: projectAutomations.conditions,
        actions: projectAutomations.actions,
        createdBy: projectAutomations.createdBy,
      })
      .from(projectAutomations)
      .where(
        and(
          eq(projectAutomations.orgId, orgId),
          eq(projectAutomations.projectId, projectId),
          eq(projectAutomations.triggerEvent, triggerEvent),
          eq(projectAutomations.isActive, true),
        ),
      );

    if (rules.length === 0) return;

    const payload: Record<string, unknown> = { ...ticket };

    for (const rule of rules) {
      try {
        const matched = evaluateBuildConditions(rule.conditions, payload);
        if (!matched) continue;

        for (const action of rule.actions) {
          await this.executeAction(orgId, ticket.ticketId, action, rule.createdBy).catch(
            (error: unknown) => {
              logger.error("BuildAutomationRunner: action failed", {
                ruleId: rule.id,
                actionType: action.type,
                error: error instanceof Error ? error.message : String(error),
              });
            },
          );
        }
      } catch (error) {
        logger.error("BuildAutomationRunner: rule execution failed", { ruleId: rule.id, error });
      }
    }
  }

  /**
   * Automation actions write tickets, labels and comments, so they must not be
   * fired into the request's own transaction and left to race its COMMIT. The
   * DRIZZLE handle is the tenant-aware proxy: a promise started here and resumed
   * after the handler returns still resolves `this.db` to the ambient `tx`, which
   * by then is committed and has lost its GUC, so the write dies 42501 and the
   * rule silently never applies. Deferring also means a rolled-back ticket write
   * cannot leave its automations applied. CLAUDE.md §4, mechanism 3.
   */
  runForTicketEvent(
    orgId: string,
    projectId: number,
    triggerEvent: string,
    ticket: TicketEventPayload,
  ): void {
    const run = (): Promise<void> =>
      this.execute(orgId, projectId, triggerEvent, ticket).catch((error: unknown) => {
        logger.error("BuildAutomationRunner: unexpected failure", {
          orgId,
          projectId,
          triggerEvent,
          error,
        });
      });

    if (!registerAfterCommit(run)) void run();
  }
}
