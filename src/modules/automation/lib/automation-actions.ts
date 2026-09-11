import { and, eq } from "drizzle-orm";
import {
  organizationMembers,
  tasks,
  supportTickets,
  supportTicketMessages,
  supportTicketTags,
  supportTags,
  type AutomationAction,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { NotificationsService } from "../../notifications/notifications.service";
import { AutomationEmailService } from "../automation-email.service";
import { AutomationWebhookService } from "../automation-webhook.service";
import { AiNodeExecutorService } from "../ai-workflow-nodes/ai-node-executor.service";
import type { AiNodeType } from "../ai-workflow-nodes/ai-node-types";
import { type EventPayload } from "../automation.evaluator";

/**
 * The action side of an automation rule: one exhaustive `switch` over the
 * `AutomationAction` union, plus the two helpers only that switch uses.
 *
 * Split out of `AutomationService` because the two halves fail differently.
 * Everything left on the service is rule LIFECYCLE — create, update, list,
 * evaluate conditions, record a run — and it reports failure by throwing
 * (`NotFoundException`) or by logging. Everything here is a side effect on
 * someone else's table or an outbound call, and it reports failure as a
 * VALUE: `executeAction` catches everything and returns
 * `{ ok: false, error }`, because one failing action must not abort the
 * remaining actions of the same rule or the remaining rules of the same
 * event. That try/catch boundary is the seam, and `assertNever` sits on this
 * side of it so adding an action type is a compile error here and nowhere
 * else.
 *
 * Two tenant guards live in this file and must stay: an assignee is checked
 * for ACTIVE membership of `orgId` before `create_task` or
 * `support_assign_ticket` writes it, and a tag is checked against
 * `supportTags.orgId` before `support_add_tag` links it. The action config
 * is org-authored JSON, so neither id is trustworthy on its own.
 */

export interface AutomationActionDeps {
  readonly db: Db;
  readonly notifications: NotificationsService;
  readonly email: AutomationEmailService;
  readonly webhookService: AutomationWebhookService;
  readonly aiNodeExecutor: AiNodeExecutorService;
}

export interface ActionResult {
  type: AutomationAction["type"];
  ok: boolean;
  error?: string;
}

function assertNever(x: never): never {
  throw new Error(`Unhandled action type: ${String(x)}`);
}

const AI_ACTION_NODE_MAP: Record<string, AiNodeType> = {
  ai_classify: "classify",
  ai_summarize: "summarize",
  ai_extract: "extract",
  ai_routing_suggestion: "routing_suggestion",
};

async function notifyMembers(
  deps: AutomationActionDeps,
  orgId: string,
  roles: string[] | null,
  content: { title: string; message: string; link?: string },
): Promise<void> {
  const members = await deps.db
    .select({ userId: organizationMembers.userId, role: organizationMembers.role })
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, orgId));

  const targets = roles ? members.filter((member) => roles.includes(member.role)) : members;
  if (targets.length === 0) return;

  await Promise.all(
    targets.map((member) =>
      deps.notifications.create({
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
function requireTicketId(payload: EventPayload): number {
  const ticketId = payload.ticketId;
  if (typeof ticketId !== "number") {
    throw new Error("This action requires a ticketId in the event payload");
  }
  return ticketId;
}

export async function executeAction(
  deps: AutomationActionDeps,
  orgId: string,
  action: AutomationAction,
  payload: EventPayload,
): Promise<ActionResult> {
  try {
    switch (action.type) {
      case "notify_roles": {
        await notifyMembers(deps, orgId, action.config.roles, {
          title: action.config.title,
          message: action.config.message,
          link: action.config.link,
        });
        return { type: action.type, ok: true };
      }
      case "notify_all": {
        await notifyMembers(deps, orgId, null, {
          title: action.config.title,
          message: action.config.message,
          link: action.config.link,
        });
        return { type: action.type, ok: true };
      }
      case "email": {
        await deps.email.send({
          to: action.config.to,
          subject: action.config.subject,
          html: action.config.body,
        });
        return { type: action.type, ok: true };
      }
      case "create_task": {
        if (action.config.assigneeId) {
          const [assignee] = await deps.db
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
        await deps.db.insert(tasks).values({
          orgId,
          title: action.config.title,
          assigneeId: action.config.assigneeId ?? null,
          dueDate,
        });
        return { type: action.type, ok: true };
      }
      case "webhook": {
        await deps.webhookService.dispatchWebhook(orgId, action.config.event, payload);
        return { type: action.type, ok: true };
      }
      case "support_assign_ticket": {
        const ticketId = requireTicketId(payload);
        const [assignee] = await deps.db
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
        await deps.db
          .update(supportTickets)
          .set({ assigneeId: action.config.assigneeId, updatedAt: new Date() })
          .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)));
        return { type: action.type, ok: true };
      }
      case "support_set_priority": {
        const ticketId = requireTicketId(payload);
        await deps.db
          .update(supportTickets)
          .set({ priority: action.config.priority as (typeof supportTickets.$inferInsert)["priority"], updatedAt: new Date() })
          .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)));
        return { type: action.type, ok: true };
      }
      case "support_add_tag": {
        const ticketId = requireTicketId(payload);
        const [tag] = await deps.db
          .select({ id: supportTags.id })
          .from(supportTags)
          .where(and(eq(supportTags.id, action.config.tagId), eq(supportTags.orgId, orgId)))
          .limit(1);
        if (!tag) throw new Error(`Tag ${String(action.config.tagId)} not found in this organisation`);
        await deps.db
          .insert(supportTicketTags)
          .values({ ticketId, tagId: action.config.tagId })
          .onConflictDoNothing();
        return { type: action.type, ok: true };
      }
      case "support_internal_note": {
        const ticketId = requireTicketId(payload);
        await deps.db.insert(supportTicketMessages).values({
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
        const result = await deps.aiNodeExecutor.executeNode(
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
