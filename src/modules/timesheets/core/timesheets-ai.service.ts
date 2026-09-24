import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  AiGatewayService,
  type AiTextStream,
  type InvokeTextOpts,
} from "../../ai/core/gateway/ai-gateway.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { PeriodsService } from "./periods.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { AiUsageMeta } from "../../ai/core/gateway/ai-gateway.types";
import type { DescribeEntryInput, RejectionDraftInput } from "./dto/ai.schemas";
import {
  buildRejectionSystemPrompt,
  buildRejectionUserPrompt,
  buildDescribeSystemPrompt,
  buildDescribeUserPrompt,
  buildPeriodSummarySystemPrompt,
  buildPeriodSummaryUserPrompt,
  buildEvidence,
} from "./timesheets-ai.prompts";
import { invokeAiText, readEvidence } from "./timesheets-ai-invoke";

const FEATURE_KEY = "timesheets.period-summary" as const;
const DESCRIBE_FEATURE_KEY = "timesheets.describe-entry" as const;
const REJECTION_FEATURE_KEY = "timesheets.rejection-draft" as const;

@Injectable()
export class TimesheetsAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly periods: PeriodsService,
  ) {}

  async summarizePeriod(
    u: CurrentUserContext,
    periodId: number,
  ): Promise<{ narration: string; evidence: Record<string, unknown> }> {
    const { options, evidence } = await this.preparePeriodSummary(u, periodId);
    const result = await this.gateway.invokeText(options);
    if (!result.ok) throw new ServiceUnavailableException(result.message);
    return { narration: result.data, evidence };
  }

  async streamSummarizePeriod(
    u: CurrentUserContext,
    periodId: number,
    signal: AbortSignal,
  ): Promise<AiTextStream & { evidence: Record<string, unknown> }> {
    const { options, evidence } = await this.preparePeriodSummary(u, periodId);
    const stream = await this.gateway.streamTextWithUsage({
      ...options,
      charge: true,
      signal,
    });
    return { ...stream, evidence };
  }

  private async preparePeriodSummary(
    u: CurrentUserContext,
    periodId: number,
  ): Promise<{ options: InvokeTextOpts; evidence: Record<string, unknown> }> {
    const detail = await readEvidence(this.db, u.orgId, () =>
      this.periods.getPeriod(u, periodId),
    );
    if (!detail) throw new NotFoundException("Period not found");

    const { period, entries } = detail;

    if (period.orgId !== u.orgId) {
      throw new ForbiddenException("Access denied");
    }

    const evidence = buildEvidence(period, entries);
    const evidenceRecord: Record<string, unknown> = evidence;

    const options: InvokeTextOpts = {
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
    };
    return { options, evidence: evidenceRecord };
  }

  async describeEntry(
    u: CurrentUserContext,
    input: DescribeEntryInput,
  ): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    return invokeAiText(this.gateway, this.prepareDescription(u, input));
  }

  streamDescribeEntry(
    u: CurrentUserContext,
    input: DescribeEntryInput,
    signal: AbortSignal,
  ): Promise<AiTextStream> {
    return this.gateway.streamTextWithUsage({
      ...this.prepareDescription(u, input),
      charge: true,
      signal,
    });
  }

  private prepareDescription(
    u: CurrentUserContext,
    input: DescribeEntryInput,
  ): InvokeTextOpts {
    return {
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
    };
  }

  async draftRejectionReason(
    u: CurrentUserContext,
    periodId: number,
    input: RejectionDraftInput,
  ): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    return invokeAiText(this.gateway, await this.prepareRejection(u, periodId, input));
  }

  async streamRejectionReason(
    u: CurrentUserContext,
    periodId: number,
    input: RejectionDraftInput,
    signal: AbortSignal,
  ): Promise<AiTextStream> {
    return this.gateway.streamTextWithUsage({
      ...(await this.prepareRejection(u, periodId, input)),
      charge: true,
      signal,
    });
  }

  private async prepareRejection(
    u: CurrentUserContext,
    periodId: number,
    input: RejectionDraftInput,
  ): Promise<InvokeTextOpts> {
    const detail = await readEvidence(this.db, u.orgId, () =>
      this.periods.getPeriod(u, periodId),
    );
    if (!detail) throw new NotFoundException("Period not found");

    return {
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
    };
  }
}
