import { and, desc, eq } from "drizzle-orm";
import { leadActivities } from "../../../../../db/schema";
import { businessParties, leadPartyMap } from "../../../../../db/schema/party";
import { runInTenantTransaction } from "../../../../../common/tenant/run-in-tenant-transaction";
import {
  INCLUDE_DELETED,
  LEAD_PARTY_COLUMNS,
  LEAD_PARTY_JOIN,
  leadIdIs,
  leadPartyScope,
} from "../../../../leads/lead-party-reader";
import { nextActionPrompt } from "../../prompts/crm.prompts";
import {
  NextActionSchema,
  NextActionWithEvidenceSchema,
  type EvidenceItem,
  type NextActionResult,
  type NextActionWithEvidenceResult,
} from "../../dto/output.schemas";
import { throwOnAiFailure } from "../gateway-result.util";
import { trunc, type LeadScoringDeps } from "./crm-lead-scoring";

/**
 * What to do about a lead next — advice that is returned and then forgotten.
 *
 * The other half of what `CrmScoringService` did to a lead, and the half that
 * WRITES NOTHING. `scoreLead` next door persists its number onto the lead mirror
 * where every pipeline view reads it; these two read the same projection, ask the
 * same gateway, and hand the answer straight back. That difference decides
 * whether a retry is free, whether a failure leaves a half-finished record, and
 * whether calling it twice means anything — which is enough of a difference to
 * be worth being able to see at a glance.
 *
 * `nextBestActionWithEvidence` is `nextBestAction` plus the signals that justify
 * the recommendation; they share `nextActionPrompt` and differ only in what they
 * add to its user turn, so they belong together and nowhere else.
 *
 * `LeadScoringDeps` and `trunc` come from `crm-lead-scoring.ts`: the deps are the
 * same two, and duplicating the prompt budget is how two callers quietly end up
 * spending different amounts.
 */

export async function nextBestAction(
  deps: LeadScoringDeps,
  orgId: string,
  leadId: number,
  userId?: string,
): Promise<NextActionResult | null> {
  const ctx = await runInTenantTransaction(deps.db, async (tx) => {
    const [[lead], [lastActivity]] = await Promise.all([
      tx
        .select({
          id: LEAD_PARTY_COLUMNS.id,
          name: LEAD_PARTY_COLUMNS.name,
          status: LEAD_PARTY_COLUMNS.status,
          priority: LEAD_PARTY_COLUMNS.priority,
          potentialValue: LEAD_PARTY_COLUMNS.potentialValue,
          assignedToId: LEAD_PARTY_COLUMNS.assignedToId,
          followUpDate: LEAD_PARTY_COLUMNS.followUpDate,
          notes: LEAD_PARTY_COLUMNS.notes,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, LEAD_PARTY_JOIN)
        .where(and(...leadPartyScope(orgId, INCLUDE_DELETED), leadIdIs(leadId))),
      tx
        .select({ type: leadActivities.type, date: leadActivities.date })
        .from(leadActivities)
        .where(eq(leadActivities.leadId, leadId))
        .orderBy(desc(leadActivities.date))
        .limit(1),
    ]);
    return { lead: lead ?? null, lastActivity: lastActivity ?? null };
  }, { orgId });

  if (!ctx.lead) return null;
  const { lead, lastActivity } = ctx;

  const now = new Date();
  const lastActivityDate = lastActivity?.date ? new Date(lastActivity.date) : null;
  const daysSinceLastActivity = lastActivityDate
    ? Math.floor((now.getTime() - lastActivityDate.getTime()) / (1000 * 60 * 60 * 24))
    : null;

  const followUpDate = lead.followUpDate ? new Date(lead.followUpDate) : null;
  const isOverdue = followUpDate ? followUpDate < now : false;

  const prompt = nextActionPrompt({
    entityType: "lead",
    name: lead.name,
    status: lead.status,
    priority: lead.priority,
    lastActivityType: lastActivity?.type ?? null,
    lastActivityDate: lastActivity?.date ? new Date(lastActivity.date).toISOString().split("T")[0] : null,
    daysSinceLastActivity,
    value: lead.potentialValue ? Number(lead.potentialValue) : null,
    assignedTo: lead.assignedToId,
    followUpDate: followUpDate?.toISOString().split("T")[0] ?? null,
    isOverdueFollowUp: isOverdue,
    notes: trunc(lead.notes),
  });

  const result = await deps.gateway.invokeStructured({
    actor: { orgId, userId: userId ?? null },
    feature: "crm.next-action",
    prompt: { system: prompt.system, user: prompt.user, promptKey: "crm.next_action", promptVersion: 1 },
    schema: NextActionSchema,
    tier: "fast",
    maxTokens: 512,
    charge: true,
  });

  if (!result.ok) throwOnAiFailure(result);
  return result.data;
}

export async function nextBestActionWithEvidence(
  deps: LeadScoringDeps,
  orgId: string,
  leadId: number,
  userId?: string,
): Promise<NextActionWithEvidenceResult | null> {
  const ctx = await runInTenantTransaction(deps.db, async (tx) => {
    const [[lead], [lastActivity], recentActivities] = await Promise.all([
      tx
        .select({
          id: LEAD_PARTY_COLUMNS.id,
          name: LEAD_PARTY_COLUMNS.name,
          status: LEAD_PARTY_COLUMNS.status,
          priority: LEAD_PARTY_COLUMNS.priority,
          potentialValue: LEAD_PARTY_COLUMNS.potentialValue,
          assignedToId: LEAD_PARTY_COLUMNS.assignedToId,
          followUpDate: LEAD_PARTY_COLUMNS.followUpDate,
          notes: LEAD_PARTY_COLUMNS.notes,
          source: LEAD_PARTY_COLUMNS.source,
          company: LEAD_PARTY_COLUMNS.company,
          email: LEAD_PARTY_COLUMNS.email,
          score: LEAD_PARTY_COLUMNS.score,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, LEAD_PARTY_JOIN)
        .where(and(...leadPartyScope(orgId, INCLUDE_DELETED), leadIdIs(leadId))),
      tx
        .select({ type: leadActivities.type, date: leadActivities.date, outcome: leadActivities.outcome })
        .from(leadActivities)
        .where(eq(leadActivities.leadId, leadId))
        .orderBy(desc(leadActivities.date))
        .limit(1),
      tx
        .select({ type: leadActivities.type, date: leadActivities.date, outcome: leadActivities.outcome })
        .from(leadActivities)
        .where(eq(leadActivities.leadId, leadId))
        .orderBy(desc(leadActivities.date))
        .limit(3),
    ]);
    return { lead: lead ?? null, lastActivity: lastActivity ?? null, recentActivities };
  }, { orgId });

  if (!ctx.lead) return null;
  const { lead, lastActivity, recentActivities } = ctx;

  const now = new Date();
  const lastActivityDate = lastActivity?.date ? new Date(lastActivity.date) : null;
  const daysSinceLastActivity = lastActivityDate
    ? Math.floor((now.getTime() - lastActivityDate.getTime()) / (1000 * 60 * 60 * 24))
    : null;

  const followUpDate = lead.followUpDate ? new Date(lead.followUpDate) : null;
  const isOverdueFollowUp = followUpDate ? followUpDate < now : false;

  const evidence: EvidenceItem[] = [];
  if (daysSinceLastActivity !== null) {
    evidence.push({ kind: "activity", label: "Days since last contact", value: String(daysSinceLastActivity) });
  }
  if (lead.score !== null && lead.score !== undefined) {
    evidence.push({ kind: "signal", label: "AI lead score", value: String(lead.score) });
  }
  if (isOverdueFollowUp) {
    evidence.push({ kind: "signal", label: "Follow-up overdue", value: "Yes" });
  }
  if (lead.status) {
    evidence.push({ kind: "field", label: "Status", value: lead.status });
  }

  const recentActivityText = recentActivities.length === 0
    ? "No recent activities."
    : recentActivities.map((a) => {
        const d = a.date ? new Date(a.date).toLocaleDateString("en-IN") : "?";
        return `[${d}] ${a.type}${a.outcome ? ` | ${a.outcome}` : ""}`;
      }).join("\n");

  const prompt = nextActionPrompt({
    entityType: "lead",
    name: lead.name,
    status: lead.status,
    priority: lead.priority,
    lastActivityType: lastActivity?.type ?? null,
    lastActivityDate: lastActivity?.date ? new Date(lastActivity.date).toISOString().split("T")[0] : null,
    daysSinceLastActivity,
    value: lead.potentialValue ? Number(lead.potentialValue) : null,
    assignedTo: lead.assignedToId,
    followUpDate: followUpDate?.toISOString().split("T")[0] ?? null,
    isOverdueFollowUp,
    notes: trunc(lead.notes),
  });

  const evidenceSummary = evidence.map((e) => `${e.label}: ${e.value}`).join("; ");
  const enhancedUser = `${prompt.user}\n\nDetected signals: ${evidenceSummary}\nRecent activities:\n${recentActivityText}\nSource: ${lead.source ?? "N/A"}, Company: ${lead.company ?? "N/A"}`;

  const result = await deps.gateway.invokeStructured({
    actor: { orgId, userId: userId ?? null },
    feature: "crm.next-action",
    prompt: { system: prompt.system, user: enhancedUser, promptKey: "crm.next_action_evidence", promptVersion: 1 },
    schema: NextActionWithEvidenceSchema,
    tier: "fast",
    maxTokens: 600,
    charge: true,
  });

  if (!result.ok) throwOnAiFailure(result);
  return result.data;
}
