import { and, eq, isNull } from "drizzle-orm";
import { crmSequenceEnrollments, tasks, deals, organizationMembers } from "../../../../db/schema";
import { businessParties, leadPartyMap } from "../../../../db/schema/party";
import type { Db } from "../../../../db/drizzle.module";
import { PARTY_OF_LEAD } from "../../crm-party-reads";
import { logger } from "../../../../common/logger/logger.service";
import { NotificationsService } from "../../../notifications/notifications.service";
import { CrmOutboundEmailService, contactUnsubscribe } from "../../consent/crm-outbound-email.service";
import type { StudioEventPayload, RunStepLog } from "../types";
import { updateMirroredLeads } from "../../../party/party-legacy-leads";
import { checkWebhookUrl } from "../../../../common/security/ssrf-guard";

const ALLOWLISTED_LEAD_FIELDS = ["status", "priority", "source", "assignedToId", "score"];
const ALLOWLISTED_DEAL_FIELDS = ["stage", "priority", "assignedToId"];

/**
 * Performing ONE automation action.
 *
 * Split from the runner because the two halves answer to different things. The
 * runner owns the run record: it walks the graph, decides which branch is taken,
 * and must finish and finalise whatever happens underneath. This file owns a
 * single side effect on somebody else's data — a task, a deal field, a webhook,
 * an email — and its contract is that **it never throws**: the catch at the
 * bottom turns any failure into a `status: "error"` step so one bad action
 * leaves the rest of the rule running and still shows up in the run log.
 *
 * That is also why the field allowlists live here and not with the graph. They
 * bound what an automation rule may write at the point of writing, so a rule
 * author cannot reach a column by naming it in a config blob.
 */
export interface AutomationActionDeps {
  readonly db: Db;
  readonly notifications: NotificationsService;
  readonly email: CrmOutboundEmailService;
}

export async function executeAction(
  deps: AutomationActionDeps,
  orgId: string,
  actionKey: string,
  config: Record<string, unknown>,
  payload: StudioEventPayload,
): Promise<RunStepLog> {
  const at = new Date().toISOString();
  const nodeId = `${actionKey}-${at}`;

  try {
    switch (actionKey) {
      case "create_task": {
        const dueDate = typeof config["dueInDays"] === "number"
          ? new Date(Date.now() + config["dueInDays"] * 86400000)
          : null;
        await deps.db.insert(tasks).values({
          orgId,
          title: String(config["title"] ?? "Task from automation"),
          entityType: payload.entityType.toUpperCase() as "LEAD" | "DEAL" | "CONTACT",
          entityId: parseInt(payload.entityId, 10),
          assigneeId: typeof config["assigneeId"] === "string" ? config["assigneeId"] : null,
          dueDate,
        });
        return { nodeId, type: actionKey, status: "ok", at };
      }
      case "send_notification": {
        if (typeof config["userId"] === "string") {
          await deps.notifications.create({
            orgId,
            userId: config["userId"],
            title: String(config["title"] ?? "CRM Automation"),
            message: String(config["message"] ?? ""),
            category: "CRM",
          });
        }
        return { nodeId, type: actionKey, status: "ok", at };
      }
      case "send_email": {
        await deps.email.send(
          orgId,
          {
            to: String(config["to"] ?? ""),
            subject: String(config["subject"] ?? ""),
            html: String(config["body"] ?? ""),
          },
          /* Only a contact has a consent row to withdraw; see the sender. */
          contactUnsubscribe(payload.entityType, payload.entityId),
        );
        return { nodeId, type: actionKey, status: "ok", at };
      }
      case "call_webhook": {
        const url = String(config["url"] ?? "");
        if (url) {
          const urlCheck = await checkWebhookUrl(url);
          if (!urlCheck.allowed) throw new Error(`SSRF: webhook URL blocked (${urlCheck.reason})`);
          const body = JSON.stringify({ event: payload.entityType, entityId: payload.entityId, data: payload.data });
          await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            signal: AbortSignal.timeout(10_000),
          });
        }
        return { nodeId, type: actionKey, status: "ok", at };
      }
      case "start_sequence": {
        const seqId = String(config["sequenceId"] ?? "");
        if (seqId) {
          await deps.db
            .insert(crmSequenceEnrollments)
            .values({ orgId, sequenceId: seqId, entityType: payload.entityType, entityId: payload.entityId })
            .onConflictDoNothing();
        }
        return { nodeId, type: actionKey, status: "ok", at };
      }
      case "stop_sequence": {
        const seqId = String(config["sequenceId"] ?? "");
        if (seqId) {
          await deps.db
            .update(crmSequenceEnrollments)
            .set({ status: "stopped", stopReason: "automation_action" })
            .where(and(
              eq(crmSequenceEnrollments.orgId, orgId),
              eq(crmSequenceEnrollments.sequenceId, seqId),
              eq(crmSequenceEnrollments.entityType, payload.entityType),
              eq(crmSequenceEnrollments.entityId, payload.entityId),
            ));
        }
        return { nodeId, type: actionKey, status: "ok", at };
      }
      case "assign_owner": {
        const targetUserId = typeof config["userId"] === "string" ? config["userId"] : null;
        if (!targetUserId) return { nodeId, type: actionKey, status: "skipped", message: "missing_userId", at };
        const [membership] = await deps.db
          .select({ userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, targetUserId)))
          .limit(1);
        if (!membership) return { nodeId, type: actionKey, status: "error", message: "user_not_in_org", at };
        if (payload.entityType === "lead") {
          await updateMirroredLeads(deps.db, orgId, [parseInt(payload.entityId, 10)], {
            assignedToId: targetUserId,
          });
        } else if (payload.entityType === "deal") {
          await deps.db.update(deals).set({ assignedToId: targetUserId })
            .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), eq(deals.id, parseInt(payload.entityId, 10))));
        } else {
          return { nodeId, type: actionKey, status: "skipped", message: "unsupported_entity", at };
        }
        return { nodeId, type: actionKey, status: "ok", at };
      }
      case "update_field": {
        const field = typeof config["field"] === "string" ? config["field"] : null;
        const value = config["value"] ?? null;
        if (!field) return { nodeId, type: actionKey, status: "skipped", message: "missing_field", at };
        if (payload.entityType === "lead") {
          if (!ALLOWLISTED_LEAD_FIELDS.includes(field)) {
            return { nodeId, type: actionKey, status: "error", message: "field_not_allowed", at };
          }
          // Every allowlisted field is a mirrored `leads` column, so the writer
          // translates the dynamic key into its party column rather than this
          // switch needing a second copy of the mapping.
          await updateMirroredLeads(deps.db, orgId, [parseInt(payload.entityId, 10)], {
            [field]: value,
          });
        } else if (payload.entityType === "deal") {
          if (!ALLOWLISTED_DEAL_FIELDS.includes(field)) {
            return { nodeId, type: actionKey, status: "error", message: "field_not_allowed", at };
          }
          await deps.db.update(deals).set({ [field]: value })
            .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), eq(deals.id, parseInt(payload.entityId, 10))));
        } else {
          return { nodeId, type: actionKey, status: "skipped", message: "unsupported_entity", at };
        }
        return { nodeId, type: actionKey, status: "ok", at };
      }
      case "add_tag": {
        const tag = typeof config["tag"] === "string" ? config["tag"].trim() : null;
        if (!tag) return { nodeId, type: actionKey, status: "skipped", message: "missing_tag", at };
        if (payload.entityType === "lead") {
          await changeLeadTags(deps, orgId, parseInt(payload.entityId, 10), (tags) =>
            tags.includes(tag) ? tags : [...tags, tag],
          );
          return { nodeId, type: actionKey, status: "ok", at };
        }
        return { nodeId, type: actionKey, status: "skipped", message: "unsupported_entity", at };
      }
      case "remove_tag": {
        const tag = typeof config["tag"] === "string" ? config["tag"].trim() : null;
        if (!tag) return { nodeId, type: actionKey, status: "skipped", message: "missing_tag", at };
        if (payload.entityType === "lead") {
          await changeLeadTags(deps, orgId, parseInt(payload.entityId, 10), (tags) =>
            tags.filter((existing) => existing !== tag),
          );
          return { nodeId, type: actionKey, status: "ok", at };
        }
        return { nodeId, type: actionKey, status: "skipped", message: "unsupported_entity", at };
      }
      case "send_whatsapp":
      case "create_deal":
      case "create_quote":
        return { nodeId, type: actionKey, status: "skipped", message: "not_implemented", at };
      default:
        return { nodeId, type: actionKey, status: "skipped", message: "unknown_action", at };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Action failed";
    logger.error("crm-automation-runner: action failed", { orgId, actionKey, error: err });
    return { nodeId, type: actionKey, status: "error", message: msg, at };
  }
}

/**
 * A tag edit, read-modify-write instead of `array_append`.
 *
 * The array operator wrote `leads.tags` without ever reading it, which the
 * mirror cannot follow: the party is the canonical copy and its tags are what
 * the legacy column is derived from. `FOR UPDATE` keeps two concurrent tag
 * edits serialised, which is what the atomic operator bought — taken on the
 * party row now that the party is what the next statement writes.
 */
async function changeLeadTags(
  deps: AutomationActionDeps,
  orgId: string,
  leadId: number,
  change: (tags: string[]) => string[],
): Promise<void> {
  if (!Number.isInteger(leadId)) return;
  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ tags: businessParties.tags })
      .from(leadPartyMap)
      .innerJoin(businessParties, PARTY_OF_LEAD)
      .where(and(eq(leadPartyMap.organizationId, orgId), eq(leadPartyMap.leadId, leadId)))
      .limit(1)
      .for("update", { of: businessParties });
    if (!row) return;
    await updateMirroredLeads(tx, orgId, [leadId], { tags: change(row.tags ?? []) });
  });
}
