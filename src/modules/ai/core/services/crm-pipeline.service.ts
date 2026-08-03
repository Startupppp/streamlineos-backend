import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, count, eq, isNull, lt, max } from "drizzle-orm";
import { dealActivities, deals, leads } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { AiGatewayService } from "../gateway/ai-gateway.service";

import { OrgFeaturesService } from "./org-features.service";
import { findDuplicateLeads } from "../../../leads/duplicate-leads";
import {
  DataQualityCopilotSchema,
  StalePipelineDigestSchema,
  type DataQualityCopilotResult,
  type StaleDeal,
} from "../dto/output.schemas";
import { throwOnAiFailure } from "./gateway-result.util";
import { AiJobsService } from "../../jobs/ai-jobs.service";

@Injectable()
export class CrmPipelineService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly orgFeatures: OrgFeaturesService,
    private readonly aiJobs: AiJobsService,
  ) {}

  async stalePipelineDigest(orgId: string, userId: string, inactiveDays = 14) {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiLeadScoring) throw new ForbiddenException("AI features are disabled for this organization");

    const [totalResult] = await this.db
      .select({ total: count() })
      .from(deals)
      .where(eq(deals.orgId, orgId));

    if ((totalResult?.total ?? 0) > 200) {
      const job = await this.aiJobs.enqueue({
        orgId,
        userId,
        type: "crm.stale-pipeline",
        payload: { inactiveDays },
        idempotencyKey: `crm-stale-pipeline-${orgId}-${inactiveDays}`,
      });
      return { jobId: job.jobId, queued: true };
    }

    const thresholdDate = new Date(Date.now() - inactiveDays * 24 * 60 * 60 * 1000);

    const activeDeals = await this.db
      .select({
        id: deals.id,
        name: deals.name,
        stage: deals.stage,
        value: deals.value,
        assignedToId: deals.assignedToId,
        updatedAt: deals.updatedAt,
      })
      .from(deals)
      .where(eq(deals.orgId, orgId))
      .limit(100);

    const dealIds = activeDeals.map((d) => d.id);
    if (dealIds.length === 0) {
      return { staleDeals: [], digest: null, inactiveDays, generatedAt: new Date().toISOString() };
    }

    const lastActivityPerDeal = await this.db
      .select({ dealId: dealActivities.dealId, lastDate: max(dealActivities.createdAt) })
      .from(dealActivities)
      .where(and(eq(dealActivities.orgId, orgId), lt(dealActivities.createdAt, thresholdDate)))
      .groupBy(dealActivities.dealId);

    const activityMap = new Map(lastActivityPerDeal.map((r) => [r.dealId, r.lastDate]));

    const now = Date.now();
    const staleDeals: StaleDeal[] = [];

    for (const deal of activeDeals) {
      const lastActivity = activityMap.get(deal.id);
      const lastDate = lastActivity ? new Date(lastActivity) : null;
      const daysSince = lastDate
        ? Math.floor((now - lastDate.getTime()) / (1000 * 60 * 60 * 24))
        : Math.floor((now - new Date(deal.updatedAt).getTime()) / (1000 * 60 * 60 * 24));

      if (daysSince < inactiveDays) continue;

      const evidence: string[] = [
        `${daysSince} days since last activity`,
        `Stage: ${deal.stage}`,
      ];
      if (deal.value) evidence.push(`Value: ₹${Number(deal.value).toLocaleString("en-IN")}`);

      staleDeals.push({
        dealId: deal.id,
        dealName: deal.name,
        stage: deal.stage,
        value: Number(deal.value ?? 0),
        daysSinceActivity: daysSince,
        assignedToId: deal.assignedToId,
        evidence,
      });
    }

    if (staleDeals.length === 0) {
      return { staleDeals: [], digest: null, inactiveDays, generatedAt: new Date().toISOString() };
    }

    const capped = staleDeals.slice(0, 50);
    const digestInput = capped
      .map((d) => `${d.dealName} (${d.stage}, ${d.daysSinceActivity}d, ₹${d.value.toLocaleString("en-IN")}): ${d.evidence.join("; ")}`)
      .join("\n");

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "crm.stale-pipeline",
      prompt: {
        system: "You are a CRM pipeline health analyst. Analyze stale deals and return a structured digest.",
        user: `Stale deals (${inactiveDays}+ days without activity):\n${digestInput}\n\nProvide a pipeline health digest.`,
      },
      schema: StalePipelineDigestSchema,
      tier: "standard",
      maxTokens: 512,
      charge: true,
    });

    if (!result.ok) throwOnAiFailure(result);
    return { staleDeals: capped, digest: result.data, inactiveDays, generatedAt: new Date().toISOString() };
  }

  async dataQualityCopilot(orgId: string, userId: string): Promise<DataQualityCopilotResult> {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiLeadScoring) throw new ForbiddenException("AI features are disabled for this organization");

    const [leadsNoEmail, leadsNoOwner, dealsIncomplete, duplicateGroups] = await Promise.all([
      this.db
        .select({ id: leads.id, name: leads.name })
        .from(leads)
        .where(and(eq(leads.orgId, orgId), isNull(leads.email), isNull(leads.deletedAt)))
        .limit(20),
      this.db
        .select({ id: leads.id, name: leads.name })
        .from(leads)
        .where(and(eq(leads.orgId, orgId), isNull(leads.assignedToId), isNull(leads.deletedAt)))
        .limit(20),
      this.db
        .select({ id: deals.id, name: deals.name, stage: deals.stage })
        .from(deals)
        .where(eq(deals.orgId, orgId))
        .limit(20),
      findDuplicateLeads(this.db, orgId),
    ]);

    type RawIssue = {
      entityType: "lead" | "deal";
      entityId: number;
      entityName: string;
      issueKind: "missing_field" | "likely_duplicate" | "incomplete_stage" | "stale_data";
      field: string | null;
      severity: "low" | "medium" | "high";
    };

    const rawIssues: RawIssue[] = [];

    for (const lead of leadsNoEmail) {
      rawIssues.push({ entityType: "lead", entityId: lead.id, entityName: lead.name, issueKind: "missing_field", field: "email", severity: "high" });
    }
    for (const lead of leadsNoOwner) {
      rawIssues.push({ entityType: "lead", entityId: lead.id, entityName: lead.name, issueKind: "missing_field", field: "assignedToId", severity: "medium" });
    }
    for (const deal of dealsIncomplete) {
      if (!deal.stage || deal.stage === "LEAD") {
        rawIssues.push({ entityType: "deal", entityId: deal.id, entityName: deal.name, issueKind: "incomplete_stage", field: "stage", severity: "low" });
      }
    }
    for (const group of duplicateGroups.slice(0, 10)) {
      const primary = group.leads[0];
      if (primary) {
        rawIssues.push({ entityType: "lead", entityId: primary.id, entityName: primary.name, issueKind: "likely_duplicate", field: null, severity: "high" });
      }
    }

    const capped = rawIssues.slice(0, 30);
    const issuesSummary = capped
      .map((i) => `${i.entityType} "${i.entityName}" (id:${i.entityId}): ${i.issueKind}${i.field ? ` on field '${i.field}'` : ""} [${i.severity}]`)
      .join("\n");

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "crm.data-quality",
      prompt: {
        system: "You are a CRM data quality specialist. Analyze issues and provide actionable fixes for each.",
        user: `CRM data quality issues detected:\n${issuesSummary}\n\nFor each issue provide a suggestedFix. Return a DataQualityCopilot report.`,
      },
      schema: DataQualityCopilotSchema,
      tier: "standard",
      maxTokens: 1024,
      charge: true,
    });

    if (!result.ok) throwOnAiFailure(result);
    return result.data;
  }
}
