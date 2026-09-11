import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PayrollAiExplainService } from "./payroll-ai-explain.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { payslipExplanationSchema, payrollAiCapabilitiesSchema } from "./dto/ai-explain-response.schemas";
import { z } from "zod";
import type { Request, Response } from "express";
import { NoTenantTransaction } from "../../../common/tenant/no-tenant-transaction.decorator";
import { AiRequestAbortInterceptor } from "../../ai/core/streaming/ai-request-abort.interceptor";
import { respondWithAiTextStream } from "../../ai/core/streaming/ai-text-stream-route";
import { AI_RESULT_STREAM_CONTENT_TYPE } from "../../ai/core/streaming/ai-result-stream";
import { ApiAiResultStream } from "../../ai/core/streaming/ai-result-stream-contract";

const publicationIdParams = z.object({ publicationId: z.coerce.number().int().positive() }).strict();

@Controller("payroll/me/payslips")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PayrollAiExplainController {
  constructor(private readonly explainService: PayrollAiExplainService) {}

  /** Honesty contract: explain/draft only — no autonomous payroll actions. */
  @Get("ai/capabilities")
  @RequirePermission("self:payslips")
  @ResponseSchema(payrollAiCapabilitiesSchema)
  aiCapabilities() {
    return this.explainService.capabilities();
  }

  @Post(":publicationId/ai/explain")
  @BodylessAction()
  @HttpCode(200)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("self:payslips")
  @Validate({ params: publicationIdParams })
  @ResponseSchema(payslipExplanationSchema)
  explainPayslip(
    @Param("publicationId", ParseIntPipe) publicationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.explainPayslip(u.orgId, u.userId, publicationId);
  }

  @Post(":publicationId/ai/explain/stream")
  @ApiAiResultStream()
  @BodylessAction()
  @HttpCode(200)
  @NoTenantTransaction()
  @UseInterceptors(AiRequestAbortInterceptor)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("self:payslips")
  @Validate({ params: publicationIdParams })
  async streamExplainPayslip(
    @Param("publicationId", ParseIntPipe) publicationId: number,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await respondWithAiTextStream(req, res, {
      feature: "payroll.explain-payslip",
      orgId: u.orgId,
      route: "POST /payroll/me/payslips/:publicationId/ai/explain/stream",
      contentType: AI_RESULT_STREAM_CONTENT_TYPE,
    }, (signal) => this.explainService.streamExplainPayslip(u.orgId, u.userId, publicationId, signal));
  }
}
