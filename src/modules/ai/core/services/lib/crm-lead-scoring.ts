import { and, count, eq } from "drizzle-orm";
import { leadActivities } from "../../../../../db/schema";
import { businessParties, leadPartyMap } from "../../../../../db/schema/party";
import { type Db } from "../../../../../db/drizzle.module";
import { logger } from "../../../../../common/logger/logger.service";
import { runInTenantTransaction } from "../../../../../common/tenant/run-in-tenant-transaction";
import {
  INCLUDE_DELETED,
  LEAD_PARTY_COLUMNS,
  LEAD_PARTY_JOIN,
  leadIdIs,
  leadPartyScope,
} from "../../../../leads/lead-party-reader";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { leadScoringPrompt } from "../../prompts/crm-scoring.prompts";
import { LeadScoreSchema, type LeadScoreResult } from "../../dto/output.schemas";
import { throwOnAiFailure } from "../gateway-result.util";
import { updateMirroredLeads } from "../../../../party/party-legacy-leads";

import { trunc } from "./prompt-text";

/**
 * Scoring a lead: the model's number, written back onto the record.
 *
 * `CrmScoringService` mixed two things the AI does with a lead. This is the one
 * that LEAVES A MARK — `scoreLead` persists the score through the lead mirror,
 * so the pipeline views, the copilot and every list that sorts by score read what
 * it decided. `lib/crm-next-action.ts` next door is the other one, which returns
 * advice and writes nothing at all; a caller that cannot tell them apart cannot
 * tell whether retrying is free.
 *
 * `batchScoreLeads` swallows a per-lead failure and logs it, because a batch of
 * fifty that aborts on the seventh has scored six and told nobody which.
 */

export interface LeadScoringDeps {
  readonly db: Db;
  readonly gateway: AiGatewayService;
}

export async function scoreLead(
  deps: LeadScoringDeps,
  orgId: string,
  leadId: number,
  userId?: string,
): Promise<LeadScoreResult | null> {
  const ctx = await runInTenantTransaction(deps.db, async (tx) => {
    const [[lead], [activityResult]] = await Promise.all([
      // Scoring is an after-effect of a write and has always run against the
      // record as it stands, deletion included; the party answers the same way.
      tx
        .select({
          id: LEAD_PARTY_COLUMNS.id,
          name: LEAD_PARTY_COLUMNS.name,
          email: LEAD_PARTY_COLUMNS.email,
          phone: LEAD_PARTY_COLUMNS.phone,
          company: LEAD_PARTY_COLUMNS.company,
          designation: LEAD_PARTY_COLUMNS.designation,
          city: LEAD_PARTY_COLUMNS.city,
          source: LEAD_PARTY_COLUMNS.source,
          priority: LEAD_PARTY_COLUMNS.priority,
          potentialValue: LEAD_PARTY_COLUMNS.potentialValue,
          investmentInterest: LEAD_PARTY_COLUMNS.investmentInterest,
          notes: LEAD_PARTY_COLUMNS.notes,
          tags: LEAD_PARTY_COLUMNS.tags,
          createdAt: LEAD_PARTY_COLUMNS.createdAt,
          assignedToId: LEAD_PARTY_COLUMNS.assignedToId,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, LEAD_PARTY_JOIN)
        .where(and(...leadPartyScope(orgId, INCLUDE_DELETED), leadIdIs(leadId))),
      tx
        .select({ count: count() })
        .from(leadActivities)
        .where(eq(leadActivities.leadId, leadId)),
    ]);
    return { lead: lead ?? null, activityCount: activityResult?.count ?? 0 };
  }, { orgId });

  if (!ctx.lead) return null;
  const { lead, activityCount } = ctx;

  const daysSinceCreated = lead.createdAt
    ? Math.floor((Date.now() - new Date(lead.createdAt).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  const prompt = leadScoringPrompt({
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    company: lead.company,
    designation: lead.designation,
    city: lead.city,
    source: lead.source,
    priority: lead.priority,
    potentialValue: lead.potentialValue,
    investmentInterest: lead.investmentInterest,
    notes: trunc(lead.notes),
    tags: lead.tags,
    daysSinceCreated,
    activityCount,
    hasAssignee: Boolean(lead.assignedToId),
  });

  const result = await deps.gateway.invokeStructured({
    actor: { orgId, userId: userId ?? null },
    feature: "crm.score-lead",
    prompt: { system: prompt.system, user: prompt.user, promptKey: "crm.lead_scoring", promptVersion: 1 },
    schema: LeadScoreSchema,
    tier: "fast",
    maxTokens: 512,
    charge: true,
  });

  if (!result.ok) throwOnAiFailure(result);
  const data = result.data;
  data.score = Math.max(0, Math.min(100, Math.round(data.score)));

  await runInTenantTransaction(deps.db, async (tx) => {
    await updateMirroredLeads(tx, orgId, [leadId], { score: data.score, updatedAt: new Date() });
  }, { orgId });

  return data;
}

export async function batchScoreLeads(
  deps: LeadScoringDeps,
  orgId: string,
  leadIds: number[],
  userId?: string,
): Promise<Map<number, LeadScoreResult>> {
  const capped = leadIds.slice(0, 50);
  const results = new Map<number, LeadScoreResult>();
  for (const leadId of capped) {
    try {
      const result = await scoreLead(deps, orgId, leadId, userId);
      if (result) results.set(leadId, result);
    } catch (error) {
      logger.error(`[ai-score] Failed to score lead ${leadId}`, { error });
    }
  }
  return results;
}
