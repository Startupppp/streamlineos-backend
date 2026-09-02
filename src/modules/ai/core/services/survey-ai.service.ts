import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, isNotNull, or } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import {
  surveyForms,
  surveyResponseSessions,
  surveyQuestions,
  surveyAnswers,
} from "../../../../db/schema";
import { AuditService } from "../../../../common/audit/audit.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import type { AiInvokePrompt } from "../gateway/ai-gateway.types";
import type { AiTextStream } from "../gateway/ai-gateway-stream.helper";
import { unwrapAiResult } from "./gateway-result.util";

const SUMMARIZE_RESPONSES_SYSTEM =
  "You are a survey analyst. Summarize the key themes, patterns, and notable insights from the survey responses. Be objective and specific. Output a narrative paragraph or two, under 600 words.";

@Injectable()
export class SurveyAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Shared by the buffered route and its streaming sibling, so the streamed
   * summary is the same answer arriving sooner rather than a different one.
   */
  private async resolveSummaryPrompt(orgId: string, surveyId: number): Promise<AiInvokePrompt> {
    // Context assembly is its own short transaction so the pooled connection is
    // returned before the provider call, which is orders of magnitude slower.
    const { title, responseCount, textRows } = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [survey] = await tx
          .select({ id: surveyForms.id, title: surveyForms.title })
          .from(surveyForms)
          .where(and(eq(surveyForms.id, surveyId), eq(surveyForms.orgId, orgId)))
          .limit(1);

        if (!survey) throw new NotFoundException("Survey not found");

        const [countRow] = await tx
          .select({ total: count() })
          .from(surveyResponseSessions)
          .where(
            and(
              eq(surveyResponseSessions.surveyId, surveyId),
              eq(surveyResponseSessions.orgId, orgId),
              eq(surveyResponseSessions.status, "submitted"),
            ),
          );

        const total = Number(countRow?.total ?? 0);
        if (total === 0) throw new BadRequestException("No submitted responses to summarize");

        const rows = await tx
          .select({
            questionTitle: surveyQuestions.title,
            answerText: surveyAnswers.answerText,
          })
          .from(surveyAnswers)
          .innerJoin(surveyQuestions, eq(surveyAnswers.questionId, surveyQuestions.id))
          .where(
            and(
              eq(surveyAnswers.orgId, orgId),
              eq(surveyAnswers.surveyId, surveyId),
              eq(surveyQuestions.orgId, orgId),
              or(
                eq(surveyQuestions.type, "short_text"),
                eq(surveyQuestions.type, "long_text"),
              ),
              isNotNull(surveyAnswers.answerText),
            ),
          )
          .limit(50);

        return { title: survey.title, responseCount: total, textRows: rows };
      },
      { orgId },
    );

    const textBlock = textRows
      .map((r) => `Q: ${r.questionTitle}\nA: ${r.answerText ?? ""}`)
      .join("\n\n")
      .slice(0, 2000);

    const user = `Survey: "${title}"\nTotal submitted responses: ${responseCount}\n\nOpen-ended responses (sample):\n${textBlock}\n\nProvide a narrative summary of key themes and insights.`;

    return { system: SUMMARIZE_RESPONSES_SYSTEM, user };
  }

  async summarizeResponses(orgId: string, userId: string, surveyId: number) {
    const prompt = await this.resolveSummaryPrompt(orgId, surveyId);

    const result = await this.gateway.invokeText({
      actor: { orgId, userId },
      feature: "survey.summarize-responses",
      prompt,
      tier: "standard",
      maxTokens: 768,
      charge: true,
    });

    const summary = unwrapAiResult(result);
    this.audit.log({ action: "ai.survey.summarize-responses", userId, orgId, resourceType: "survey", resourceId: String(surveyId) });
    return { summary: summary.slice(0, 2000) };
  }

  async streamSummarizeResponses(
    orgId: string,
    userId: string,
    surveyId: number,
    signal?: AbortSignal,
  ): Promise<AiTextStream> {
    const prompt = await this.resolveSummaryPrompt(orgId, surveyId);
    this.audit.log({ action: "ai.survey.summarize-responses", userId, orgId, resourceType: "survey", resourceId: String(surveyId) });
    return this.gateway.streamTextWithUsage({
      actor: { orgId, userId },
      feature: "survey.summarize-responses",
      prompt,
      maxTokens: 768,
      charge: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }
}
