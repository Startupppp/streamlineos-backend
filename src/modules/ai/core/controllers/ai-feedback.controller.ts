import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../../common/pipes/zod-validation.pipe";
import { AiFeedbackService } from "../services/ai-feedback.service";
import {
  createFeedbackSchema,
  feedbackSummaryQuerySchema,
  type CreateFeedbackDto,
  type FeedbackSummaryQuery,
} from "../dto/ai-feedback.schemas";

@Controller("ai/feedback")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AiFeedbackController {
  constructor(private readonly aiFeedback: AiFeedbackService) {}

  @Post()
  @HttpCode(201)
  @RequirePermission("ai:feedback:create")
  async create(
    @Body(new ZodValidationPipe(createFeedbackSchema)) body: CreateFeedbackDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.aiFeedback.insertFeedback(u.orgId, u.userId, body);
    return { success: true };
  }

  @Get("summary")
  @RequirePermission("settings:manage")
  async summary(
    @Query(new ZodValidationPipe(feedbackSummaryQuerySchema)) query: FeedbackSummaryQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.aiFeedback.getSummary(u.orgId, query.feature, query.days);
  }
}
