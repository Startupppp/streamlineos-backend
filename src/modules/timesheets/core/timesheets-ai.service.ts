import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { PeriodsService } from "./periods.service";
import { BillingService } from "./billing.service";
import { ReportsService } from "./reports.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { AiUsageMeta } from "../../ai/core/gateway/ai-gateway.types";
import { throwOnAiFailure } from "../../ai/core/services/gateway-result.util";
import type { DescribeEntryInput, BillingNarrativeInput, RejectionDraftInput } from "./dto/ai.schemas";
import type { OverviewQuery } from "./dto/reports.schemas";
import {
  buildRejectionSystemPrompt,
  buildRejectionUserPrompt,
  buildReportsSystemPrompt,
  buildReportsUserPrompt,
  buildNarrativeEvidence,
  buildNarrativeSystemPrompt,
  buildNarrativeUserPrompt,
  buildDescribeSystemPrompt,
  buildDescribeUserPrompt,
  buildPeriodSummarySystemPrompt,
  buildPeriodSummaryUserPrompt,
  buildEvidence,
} from "./timesheets-ai.prompts";

const FEATURE_KEY = "timesheets.period-summary" as const;
const DESCRIBE_FEATURE_KEY = "timesheets.describe-entry" as const;
const NARRATIVE_FEATURE_KEY = "timesheets.billing-narrative" as const;
const REPORTS_FEATURE_KEY = "timesheets.reports-narrative" as const;
const REJECTION_FEATURE_KEY = "timesheets.rejection-draft" as const;

/**
 * Every method here reads evidence from the database and then calls a provider.
 * The two are deliberately separated: `readEvidence` opens a short tenant
 * transaction, commits it, and only then does the gateway call go out. The
 * controller's `@NoTenantTransaction()` means there is no ambient request
 * transaction to hold open across that round trip (PRD-C078 / C147).
 */
@Injectable()
export class TimesheetsAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly periods: PeriodsService,
    private readonly billing: BillingService,
    private readonly reports: ReportsService,
  ) {}

  /**
   * Runs `read` in its own tenant transaction that commits before returning, so
   * the pooled connection is back before the caller talks to the provider.
   * `this.db` is the tenant-aware proxy, so the delegate services inside `read`
   * pick up this transaction's GUC with no signature change. If some caller does
   * have an ambient tenant context, `runInTenantTransaction` reuses it rather
   * than nesting.
   */
  private readEvidence<T>(orgId: string, read: () => Promise<T>): Promise<T> {
    return runInTenantTransaction(this.db, read, { orgId });
  }

  async summarizePeriod(u: CurrentUserContext, periodId: number): Promise<{ narration: string; evidence: Record<string, unknown> }> {
    const detail = await this.readEvidence(u.orgId, () => this.periods.getPeriod(u, periodId));
    if (!detail) throw new NotFoundException("Period not found");

    const { period, entries } = detail;

    if (period.orgId !== u.orgId) {
      throw new ForbiddenException("Access denied");
    }

    const evidence = buildEvidence(period, entries);
    const evidenceRecord: Record<string, unknown> = evidence;

    const result = await this.gateway.invokeText({
      actor: { orgId: u.orgId, userId: u.userId },
      feature: FEATURE_KEY,
      tier: "fast",
      maxTokens: 512,
      charge: true,
      redact: false,
      prompt: {
        system: buildPeriodSummarySystemPrompt(),
        user: buildPeriodSummaryUserPrompt(evidenceRecord),
        promptKey: "timesheets.period-summary",
        promptVersion: 1,
      },
    });

    if (!result.ok) {
      throw new ServiceUnavailableException(result.message);
    }

    return { narration: result.data, evidence: evidenceRecord };
  }

  async describeEntry(
    u: CurrentUserContext,
    input: DescribeEntryInput,
  ): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    const result = await this.gateway.invokeTextWithUsage({
      actor: { orgId: u.orgId, userId: u.userId },
      feature: DESCRIBE_FEATURE_KEY,
      tier: "fast",
      maxTokens: 200,
      charge: true,
      prompt: {
        system: buildDescribeSystemPrompt(),
        user: buildDescribeUserPrompt(input),
        promptKey: DESCRIBE_FEATURE_KEY,
        promptVersion: 1,
      },
    });

    if (!result.ok) return throwOnAiFailure(result);
    return { text: result.data, aiUsage: result.aiUsage };
  }

  async draftRejectionReason(
    u: CurrentUserContext,
    periodId: number,
    input: RejectionDraftInput,
  ): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    const detail = await this.readEvidence(u.orgId, () => this.periods.getPeriod(u, periodId));
    if (!detail) throw new NotFoundException("Period not found");

    const result = await this.gateway.invokeTextWithUsage({
      actor: { orgId: u.orgId, userId: u.userId },
      feature: REJECTION_FEATURE_KEY,
      tier: "fast",
      maxTokens: 220,
      charge: true,
      prompt: {
        system: buildRejectionSystemPrompt(),
        user: buildRejectionUserPrompt(
          buildEvidence(detail.period, detail.entries),
          input.note,
        ),
        promptKey: REJECTION_FEATURE_KEY,
        promptVersion: 1,
      },
    });

    if (!result.ok) return throwOnAiFailure(result);
    return { text: result.data, aiUsage: result.aiUsage };
  }

  async reportsNarrative(
    u: CurrentUserContext,
    query: OverviewQuery,
  ): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    const overview = await this.readEvidence(u.orgId, () => this.reports.getOverview(u, query));
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

    const result = await this.gateway.invokeTextWithUsage({
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
    });

    if (!result.ok) return throwOnAiFailure(result);
    return { text: result.data, aiUsage: result.aiUsage };
  }

  async billingNarrative(
    u: CurrentUserContext,
    input: BillingNarrativeInput,
  ): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    const items = await this.readEvidence(u.orgId, () =>
      this.billing.getBillableWorkForNarrative(u, input),
    );
    if (items.length === 0) {
      throw new BadRequestException(
        "No uninvoiced billable work found for the selected range.",
      );
    }

    const result = await this.gateway.invokeTextWithUsage({
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
    });

    if (!result.ok) return throwOnAiFailure(result);
    return { text: result.data, aiUsage: result.aiUsage };
  }
}
