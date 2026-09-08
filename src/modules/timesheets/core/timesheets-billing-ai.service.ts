import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import {
  AiGatewayService,
  type AiTextStream,
  type InvokeTextOpts,
} from "../../ai/core/gateway/ai-gateway.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { BillingService } from "./billing.service";
import { ReportsService } from "./reports.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { AiUsageMeta } from "../../ai/core/gateway/ai-gateway.types";
import type { BillingNarrativeInput } from "./dto/ai.schemas";
import type { OverviewQuery } from "./dto/reports.schemas";
import {
  buildReportsSystemPrompt,
  buildReportsUserPrompt,
  buildNarrativeEvidence,
  buildNarrativeSystemPrompt,
  buildNarrativeUserPrompt,
} from "./timesheets-ai.prompts";
import { invokeAiText, readEvidence } from "./timesheets-ai-invoke";

const NARRATIVE_FEATURE_KEY = "timesheets.billing-narrative" as const;
const REPORTS_FEATURE_KEY = "timesheets.reports-narrative" as const;

/**
 * The reporting and invoicing half of the timesheets AI surface. Evidence is
 * read in a short tenant transaction that commits before the provider call, so
 * no pooled connection is held across the round trip (PRD-C078 / C147).
 */
@Injectable()
export class TimesheetsBillingAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly billing: BillingService,
    private readonly reports: ReportsService,
  ) {}

  async reportsNarrative(
    u: CurrentUserContext,
    query: OverviewQuery,
  ): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    return invokeAiText(this.gateway, await this.prepareReports(u, query));
  }

  async streamReportsNarrative(
    u: CurrentUserContext,
    query: OverviewQuery,
    signal: AbortSignal,
  ): Promise<AiTextStream> {
    return this.gateway.streamTextWithUsage({
      ...(await this.prepareReports(u, query)),
      charge: true,
      signal,
    });
  }

  private async prepareReports(
    u: CurrentUserContext,
    query: OverviewQuery,
  ): Promise<InvokeTextOpts> {
    const overview = await readEvidence(this.db, u.orgId, () =>
      this.reports.getOverview(u, query),
    );
    if (overview.totalHours === 0) {
      throw new BadRequestException(
        "No timesheet data found for the selected range.",
      );
    }

    const evidence = {
      ...overview,
      byDay: overview.byDay.slice(-60),
      byProject: overview.byProject.slice(0, 40),
      dateRange: { start: query.startDate ?? null, end: query.endDate ?? null },
    };

    return {
      actor: { orgId: u.orgId, userId: u.userId },
      feature: REPORTS_FEATURE_KEY,
      tier: "fast",
      maxTokens: 500,
      charge: true,
      prompt: {
        system: buildReportsSystemPrompt(),
        user: buildReportsUserPrompt(evidence),
        promptKey: REPORTS_FEATURE_KEY,
        promptVersion: 1,
      },
    };
  }

  async billingNarrative(
    u: CurrentUserContext,
    input: BillingNarrativeInput,
  ): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    return invokeAiText(this.gateway, await this.prepareBilling(u, input));
  }

  async streamBillingNarrative(
    u: CurrentUserContext,
    input: BillingNarrativeInput,
    signal: AbortSignal,
  ): Promise<AiTextStream> {
    return this.gateway.streamTextWithUsage({
      ...(await this.prepareBilling(u, input)),
      charge: true,
      signal,
    });
  }

  private async prepareBilling(
    u: CurrentUserContext,
    input: BillingNarrativeInput,
  ): Promise<InvokeTextOpts> {
    const items = await readEvidence(this.db, u.orgId, () =>
      this.billing.getBillableWorkForNarrative(u, input),
    );
    if (items.length === 0) {
      throw new BadRequestException(
        "No uninvoiced billable work found for the selected range.",
      );
    }

    return {
      actor: { orgId: u.orgId, userId: u.userId },
      feature: NARRATIVE_FEATURE_KEY,
      tier: "fast",
      maxTokens: 600,
      charge: true,
      prompt: {
        system: buildNarrativeSystemPrompt(),
        user: buildNarrativeUserPrompt(buildNarrativeEvidence(items)),
        promptKey: NARRATIVE_FEATURE_KEY,
        promptVersion: 1,
      },
    };
  }
}
