import { Body, Controller, HttpCode, Param, ParseIntPipe, Post, Req, Res, UseGuards, UseInterceptors } from "@nestjs/common";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { AiRequestAbortInterceptor, respondWithAiTextStream } from "../../ai/core/streaming";
import { AI_RESULT_STREAM_CONTENT_TYPE, createAiResultStream } from "../../ai/core/streaming/ai-result-stream";
import type { AiTextStream } from "../../ai/core/gateway/ai-gateway.service";
import { ApiAiResultStream } from "../../ai/core/streaming/ai-result-stream-contract";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { TimesheetsAiService } from "./timesheets-ai.service";
import { TimesheetsBillingAiService } from "./timesheets-billing-ai.service";
import {
  describeEntrySchema,
  type DescribeEntryInput,
  billingNarrativeSchema,
  type BillingNarrativeInput,
  rejectionDraftSchema,
  type RejectionDraftInput,
} from "./dto/ai.schemas";
import { overviewQuerySchema, type OverviewQuery } from "./dto/reports.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { NoTenantTransaction } from "../../../common/tenant/no-tenant-transaction.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { aiTextResponseSchema, aiSummarizePeriodResponseSchema } from "./dto/timesheets-response.schemas";
import { z } from "zod";

const periodIdParams = z.object({ periodId: z.coerce.number().int().positive() }).strict();

/**
 * Every handler here carries `@NoTenantTransaction()`. Each one ends in an
 * `AiGatewayService` call — a provider network round trip — and under the
 * request-scoped tenant transaction that call was made while a pooled database
 * connection was still checked out and idle-in-transaction, for the full
 * duration of someone else's outage (backend CLAUDE.md §4, PRD-C078/C147).
 *
 * `TimesheetsAiService` now opens its own short tenant transaction around the
 * evidence reads and commits it before invoking the gateway. Everything the
 * gateway itself touches — the credit reservation, the settlement and the
 * `ai_usage_logs` insert — already passes an explicit `orgId`, so no statement
 * reaches the pool without a tenant GUC.
 *
 * The opt-out also removes the tenant context's disconnect signal, which is the
 * only thing `getAmbientAiAbortSignal` had to read on these five routes — hence
 * `@UseInterceptors(AiRequestAbortInterceptor)` on the class. Without it the
 * released connection would have been paid for with an uncancellable provider
 * call: a client that hangs up still gets billed for tokens nobody reads
 * (PRD-C091). Same pairing as `KbAuthoringController`.
 */
@RequireModule("timesheets")
@Controller("timesheets")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard, RateLimitGuard)
@UseInterceptors(AiRequestAbortInterceptor)
export class TimesheetsAiController {
  constructor(
    private readonly ai: TimesheetsAiService,
    private readonly billingAi: TimesheetsBillingAiService,
  ) {}

  @Post("periods/:periodId/ai/summarize")
  @BodylessAction()
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("timesheets:entries:view")
  @UseRateLimit("ai:invoke")
  @Validate({ params: periodIdParams })
  @ResponseSchema(aiSummarizePeriodResponseSchema)
  summarize(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ai.summarizePeriod(u, periodId);
  }

  @Post("periods/:periodId/ai/rejection-reason")
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("timesheets:approvals:manage")
  @UseRateLimit("ai:invoke")
  @Validate({ params: periodIdParams, body: rejectionDraftSchema })
  @ResponseSchema(aiTextResponseSchema)
  draftRejectionReason(
    @Param("periodId", ParseIntPipe) periodId: number,
    @Body() body: RejectionDraftInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ai.draftRejectionReason(u, periodId, body);
  }

  @Post("ai/describe-entry")
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("timesheets:entries:create")
  @UseRateLimit("ai:invoke")
  @Validate({ body: describeEntrySchema })
  @ResponseSchema(aiTextResponseSchema)
  describeEntry(
    @Body() body: DescribeEntryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ai.describeEntry(u, body);
  }

  @Post("ai/billing-narrative")
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("timesheets:billing:view")
  @UseRateLimit("ai:invoke")
  @Validate({ body: billingNarrativeSchema })
  @ResponseSchema(aiTextResponseSchema)
  billingNarrative(
    @Body() body: BillingNarrativeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billingAi.billingNarrative(u, body);
  }

  @Post("ai/reports-narrative")
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("timesheets:reports:view")
  @UseRateLimit("ai:invoke")
  @Validate({ body: overviewQuerySchema })
  @ResponseSchema(aiTextResponseSchema)
  reportsNarrative(
    @Body() body: OverviewQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billingAi.reportsNarrative(u, body);
  }

  @Post("periods/:periodId/ai/summarize/stream")
  @ApiAiResultStream()
  @BodylessAction()
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("timesheets:entries:view")
  @UseRateLimit("ai:invoke")
  @Validate({ params: periodIdParams })
  summarizeStream(
    @Req() req: Request, @Res() res: Response,
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    return respondWithAiTextStream(req, res, {
      feature: "timesheets.period-summary", orgId: u.orgId,
      route: "POST /timesheets/periods/:periodId/ai/summarize/stream",
      contentType: AI_RESULT_STREAM_CONTENT_TYPE,
    }, async (signal) => {
      const generation = await this.ai.streamSummarizePeriod(u, periodId, signal);
      return createAiResultStream({
        generation, signal,
        complete: async (narration, aiUsage) => ({ narration, evidence: generation.evidence, aiUsage }),
      });
    });
  }

  @Post("periods/:periodId/ai/rejection-reason/stream")
  @ApiAiResultStream()
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("timesheets:approvals:manage")
  @UseRateLimit("ai:invoke")
  @Validate({ params: periodIdParams, body: rejectionDraftSchema })
  rejectionReasonStream(
    @Req() req: Request, @Res() res: Response,
    @Param("periodId", ParseIntPipe) periodId: number,
    @Body() body: RejectionDraftInput, @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    return this.respondText(req, res, u, "timesheets.rejection-draft",
      "POST /timesheets/periods/:periodId/ai/rejection-reason/stream",
      (signal) => this.ai.streamRejectionReason(u, periodId, body, signal));
  }

  @Post("ai/describe-entry/stream")
  @ApiAiResultStream()
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("timesheets:entries:create")
  @UseRateLimit("ai:invoke")
  @Validate({ body: describeEntrySchema })
  describeEntryStream(
    @Req() req: Request, @Res() res: Response,
    @Body() body: DescribeEntryInput, @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    return this.respondText(req, res, u, "timesheets.describe-entry",
      "POST /timesheets/ai/describe-entry/stream",
      (signal) => this.ai.streamDescribeEntry(u, body, signal));
  }

  @Post("ai/billing-narrative/stream")
  @ApiAiResultStream()
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("timesheets:billing:view")
  @UseRateLimit("ai:invoke")
  @Validate({ body: billingNarrativeSchema })
  billingNarrativeStream(
    @Req() req: Request, @Res() res: Response,
    @Body() body: BillingNarrativeInput, @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    return this.respondText(req, res, u, "timesheets.billing-narrative",
      "POST /timesheets/ai/billing-narrative/stream",
      (signal) => this.billingAi.streamBillingNarrative(u, body, signal));
  }

  @Post("ai/reports-narrative/stream")
  @ApiAiResultStream()
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("timesheets:reports:view")
  @UseRateLimit("ai:invoke")
  @Validate({ body: overviewQuerySchema })
  reportsNarrativeStream(
    @Req() req: Request, @Res() res: Response,
    @Body() body: OverviewQuery, @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    return this.respondText(req, res, u, "timesheets.reports-narrative",
      "POST /timesheets/ai/reports-narrative/stream",
      (signal) => this.billingAi.streamReportsNarrative(u, body, signal));
  }

  private respondText(
    req: Request, res: Response, u: CurrentUserContext,
    feature: string, route: string,
    produce: (signal: AbortSignal) => Promise<AiTextStream>,
  ): Promise<void> {
    return respondWithAiTextStream(req, res, {
      feature, route, orgId: u.orgId, contentType: AI_RESULT_STREAM_CONTENT_TYPE,
    }, async (signal) => createAiResultStream({
      generation: await produce(signal), signal,
      complete: async (text, aiUsage) => ({ text, aiUsage }),
    }));
  }
}
