import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, not } from "drizzle-orm";
import { deals, quotes, crmOptions, crmPipelineStages } from "../../../db/schema";
import { businessParties, leadPartyMap } from "../../../db/schema/party";
import { PARTY_OF_LEAD, leadStatus } from "../crm-party-reads";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { DataScope } from "../../access/access.types";
import { applyScope } from "../../access/apply-scope";
import { resolveLeadStatusSemantics } from "../../leads/lead-status-semantics";

export interface AiAction {
  type: string;
  entityType: "lead" | "deal" | "quote";
  entityId: number;
  title: string;
  reason: string;
  href: string;
}

@Injectable()
export class CrmInboxAiActionsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async resolveMetadata(orgId: string): Promise<{ terminalLeadKeys: string[]; openStageKeys: string[] }> {
    const [leadStatusOptions, pipelineStageRows] = await Promise.all([
      this.db
        .select({ key: crmOptions.key, isTerminal: crmOptions.isTerminal, metadata: crmOptions.metadata })
        .from(crmOptions)
        .where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status"), eq(crmOptions.isActive, true))),
      this.db
        .select({ key: crmPipelineStages.key })
        .from(crmPipelineStages)
        .where(and(eq(crmPipelineStages.orgId, orgId), eq(crmPipelineStages.isActive, true), eq(crmPipelineStages.isTerminal, false))),
    ]);

    const semantics = resolveLeadStatusSemantics(
      leadStatusOptions.map((o) => ({
        key: o.key,
        isTerminal: o.isTerminal ?? false,
        metadata: (o.metadata as Record<string, unknown> | null) ?? null,
      })),
    );

    const terminalLeadKeys = [...semantics.convertedKeys, ...semantics.lostKeys];
    const openStageKeys = pipelineStageRows.map((r) => r.key);

    return { terminalLeadKeys, openStageKeys };
  }

  async computeAiActions(
    orgId: string,
    userId: string,
    scope: DataScope,
    terminalLeadKeys: string[],
    openStageKeys: string[],
  ): Promise<AiAction[]> {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const todayString = now.toISOString().slice(0, 10);
    const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const leadScopeFilter = applyScope(scope, orgId, userId, { ownerColumn: businessParties.ownerUserId });

    const [hotLeads, slaDeals, expiringQuotes] = await Promise.all([
      this.db
        .select({ id: leadPartyMap.leadId, name: businessParties.name })
        .from(leadPartyMap)
        .innerJoin(businessParties, PARTY_OF_LEAD)
        .where(
          and(
            eq(leadPartyMap.organizationId, orgId),
            not(inArray(leadStatus, terminalLeadKeys)),
            isNull(businessParties.deletedAt),
            // "Nothing has happened to this record in a week" now reads the
            // party's own stamp. Both tables are written in one transaction, so
            // they carry the same instant -- and 0241 carried the legacy value
            // across, so this is not a clock that restarted at the backfill.
            lte(businessParties.updatedAt, sevenDaysAgo),
            leadScopeFilter,
          ),
        )
        .orderBy(businessParties.nextFollowUpAt)
        .limit(3),

      openStageKeys.length > 0
        ? this.db
            .select({ id: deals.id, name: deals.name })
            .from(deals)
            .where(
              and(
                eq(deals.orgId, orgId), isNull(deals.deletedAt),
                inArray(deals.stage, openStageKeys),
                isNotNull(deals.slaDeadline),
                lt(deals.slaDeadline, now),
              ),
            )
            .limit(3)
        : Promise.resolve([] as { id: number; name: string }[]),

      this.db
        .select({ id: quotes.id, quoteNumber: quotes.quoteNumber, dealId: quotes.dealId })
        .from(quotes)
        .where(
          and(
            eq(quotes.orgId, orgId), isNull(quotes.deletedAt),
            inArray(quotes.status, ["SENT", "DRAFT"]),
            lte(quotes.validUntil, threeDaysFromNow),
            gte(quotes.validUntil, todayString),
          ),
        )
        .limit(4),
    ]);

    const actions: AiAction[] = [
      ...hotLeads.map(
        (l): AiAction => ({
          type: "call_lead",
          entityType: "lead",
          entityId: l.id,
          title: "Follow up with " + l.name,
          reason: "No contact in 7+ days",
          href: "/crm/leads/" + String(l.id),
        }),
      ),
      ...slaDeals.map(
        (d): AiAction => ({
          type: "advance_deal",
          entityType: "deal",
          entityId: d.id,
          title: "Advance or update " + d.name,
          reason: "Past SLA deadline",
          href: "/crm/deals/" + String(d.id),
        }),
      ),
      ...expiringQuotes.map(
        (q): AiAction => ({
          type: "follow_up_quote",
          entityType: "quote",
          entityId: q.id,
          title: "Follow up on quote " + q.quoteNumber,
          reason: "Quote expiring in ≤3 days",
          href: q.dealId != null ? "/crm/deals/" + String(q.dealId) : "/crm/quotes/" + String(q.id),
        }),
      ),
    ];

    return actions.slice(0, 10);
  }
}
