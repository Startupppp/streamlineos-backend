import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { assertNever } from "../../common/types/assert-never";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  organizationMembers, tasks, supportTickets, supportTicketMessages,
  supportTicketTags, supportTags, type AutomationAction,
} from "../../db/schema";
import { NotificationsService } from "../notifications/notifications.service";
import { AutomationEmailService } from "./automation-email.service";
import { WebhooksDispatchService } from "../webhooks/webhooks-dispatch.service";
import { AiNodeExecutorService } from "./ai-workflow-nodes/ai-node-executor.service";
import type { AiNodeType } from "./ai-workflow-nodes/ai-node-types";
import type { EventPayload } from "./automation.evaluator";

export interface ActionResult {
  type: AutomationAction["type"];
  ok: boolean;
  error?: string;
}

const AI_ACTION_NODE_MAP: Record<string, AiNodeType> = {
  ai_classify: "classify",
  ai_summarize: "summarize",
  ai_extract: "extract",
  ai_routing_suggestion: "routing_suggestion",
};

/** Owns action execution for automations and workflows, containing failures at the action boundary. */
@Injectable()
export class AutomationActionExecutor {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly email: AutomationEmailService,
    private readonly webhookService: WebhooksDispatchService,
    private readonly aiNodeExecutor: AiNodeExecutorService,
  ) {}

  private async notifyMembers(
    orgId: string,
    roles: string[] | null,
    content: { title: string; message: string; link?: string },
  ): Promise<void> {
    const members = await this.db
      .select({ userId: organizationMembers.userId, role: organizationMembers.role })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId));

    const targets = roles ? members.filter((member) => roles.includes(member.role)) : members;
    if (targets.length === 0) return;

    await Promise.all(
      targets.map((member) =>
        this.notifications.create({
          orgId,
          userId: member.userId,
          title: content.title,
          message: content.message,
          link: content.link,
        }),
      ),
    );
  }

  /** support_* actions only make sense for ticket-lifecycle triggers, which always include ticketId in the payload. */
  private requireTicketId(payload: EventPayload): number {
    const ticketId = payload.ticketId;
    if (typeof ticketId !== "number") {
      throw new Error("This action requires a ticketId in the event payload");
    }
    return ticketId;
  }

  async executeAction(
    orgId: string,
    action: AutomationAction,
    payload: EventPayload,
  ): Promise<ActionResult> {
    try {
      switch (action.type) {
        case "notify_roles": {
          await this.notifyMembers(orgId, action.config.roles, {
            title: action.config.title,
            message: action.config.message,
            link: action.config.link,
          });
          return { type: action.type, ok: true };
        }
        case "notify_all": {
          await this.notifyMembers(orgId, null, {
            title: action.config.title,
            message: action.config.message,
            link: action.config.link,
          });
          return { type: action.type, ok: true };
        }
        case "email": {
          await this.email.send({
            to: action.config.to,
            subject: action.config.subject,
            html: action.config.body,
          });
          return { type: action.type, ok: true };
        }
        case "create_task": {
          if (action.config.assigneeId) {
            const [assignee] = await this.db
              .select({ status: organizationMembers.status })
              .from(organizationMembers)
              .where(
                and(
                  eq(organizationMembers.userId, action.config.assigneeId),
                  eq(organizationMembers.orgId, orgId),
                ),
              )
              .limit(1);
            if (!assignee || assignee.status !== "ACTIVE")
              return {
                type: action.type,
                ok: false,
                error: `Assignee is not an active member of this organisation`,
              };
          }
          const dueDate =
            typeof action.config.dueInDays === "number"
              ? new Date(Date.now() + action.config.dueInDays * 24 * 60 * 60 * 1000)
              : null;
          await this.db.insert(tasks).values({
            orgId,
            title: action.config.title,
            assigneeId: action.config.assigneeId ?? null,
            dueDate,
          });
          return { type: action.type, ok: true };
        }
        case "webhook": {
          this.webhookService.dispatch(orgId, action.config.event, payload);
          return { type: action.type, ok: true };
        }
        case "support_assign_ticket": {
          const ticketId = this.requireTicketId(payload);
          const [assignee] = await this.db
            .select({ id: organizationMembers.id, status: organizationMembers.status })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.userId, action.config.assigneeId),
                eq(organizationMembers.orgId, orgId),
              ),
            )
            .limit(1);
          if (!assignee || assignee.status !== "ACTIVE")
            return {
              type: action.type,
              ok: false,
              error: `Assignee is not an active member of this organisation`,
            };
          await this.db
            .update(supportTickets)
            .set({ assigneeMembershipId: assignee.id, updatedAt: new Date() })
            .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)));
          return { type: action.type, ok: true };
        }
        case "support_set_priority": {
          const ticketId = this.requireTicketId(payload);
          await this.db
            .update(supportTickets)
            .set({ priority: action.config.priority as (typeof supportTickets.$inferInsert)["priority"], updatedAt: new Date() })
            .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)));
          return { type: action.type, ok: true };
        }
        case "support_add_tag": {
          const ticketId = this.requireTicketId(payload);
          const [tag] = await this.db
            .select({ id: supportTags.id })
            .from(supportTags)
            .where(and(eq(supportTags.id, action.config.tagId), eq(supportTags.orgId, orgId)))
            .limit(1);
          if (!tag) throw new Error(`Tag ${String(action.config.tagId)} not found in this organisation`);
          await this.db
            .insert(supportTicketTags)
            .values({ orgId, ticketId, tagId: action.config.tagId })
            .onConflictDoNothing();
          return { type: action.type, ok: true };
        }
        case "support_internal_note": {
          const ticketId = this.requireTicketId(payload);
          await this.db.insert(supportTicketMessages).values({
            orgId,
            ticketId,
            authorId: null,
            body: action.config.body,
            isInternal: true,
            sourceChannel: "internal",
          });
          return { type: action.type, ok: true };
        }
        case "ai_classify":
        case "ai_summarize":
        case "ai_extract":
        case "ai_routing_suggestion": {
          const nodeType = AI_ACTION_NODE_MAP[action.type];
          if (!nodeType) return { type: action.type, ok: false, error: "Unknown AI node type" };
          const result = await this.aiNodeExecutor.executeNode(
            orgId,
            "system",
            nodeType,
            action.config,
            payload,
          );
          return { type: action.type, ok: result.ok, error: result.error };
        }
        default:
          return assertNever(action);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Action execution failed";
      return { type: action.type, ok: false, error: message };
    }
  }

}
