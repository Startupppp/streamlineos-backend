import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { Validate } from "../../../../common/validation/validate.decorator";
import { AiFeedbackService } from "../services/ai-feedback.service";
import { NoTenantTransaction } from "../../../../common/tenant/no-tenant-transaction.decorator";
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { aiFeedbackCreateResponseSchema, aiFeedbackSummaryResponseSchema } from "../dto/ai-response.schemas";
import {
  createFeedbackSchema,
  feedbackSummaryQuerySchema,
  type CreateFeedbackDto,
  type FeedbackSummaryQuery,
} from "../dto/ai-feedback.schemas";
import { AiRequestAbortInterceptor } from "../streaming";

@Controller("ai/feedback")
@UseGuards(JwtAuthGuard, PermissionGuard)
@NoTenantTransaction()
@UseInterceptors(AiRequestAbortInterceptor)
export class AiFeedbackController {
  constructor(private readonly aiFeedback: AiFeedbackService) {}

  @Post()
  @HttpCode(201)
  @RequirePermission("ai:feedback:create")
  @ResponseSchema(aiFeedbackCreateResponseSchema)
  @Validate({ body: createFeedbackSchema })
  async create(
    @Body() body: CreateFeedbackDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.aiFeedback.insertFeedback(u.orgId, u.userId, body);
    return { success: true };
  }

  @Get("summary")
  @RequirePermission("settings:manage")
  @ResponseSchema(aiFeedbackSummaryResponseSchema)
  @Validate({ query: feedbackSummaryQuerySchema })
  async summary(
    @Query() query: FeedbackSummaryQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.aiFeedback.getSummary(u.orgId, query.feature, query.days);
  }
}
