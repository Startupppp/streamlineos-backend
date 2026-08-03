import { Controller, Get, HttpCode, Post, Patch, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { FeedbackService } from "./feedback.service";
import {
  createFeedbackCycleSchema,
  updateCycleStatusSchema,
  submitFeedbackResponseSchema,
  type CreateFeedbackCycleInput,
  type UpdateCycleStatusInput,
  type SubmitFeedbackResponseInput,
} from "./dto/feedback.schemas";

@RequireModule("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller("hr/feedback")
export class FeedbackController {
  constructor(private readonly service: FeedbackService) {}

  @Get("cycles")
  @RequirePermission("hr:performance:view")
  listCycles(@CurrentUser() u: CurrentUserContext) {
    return this.service.listCycles(u.orgId);
  }

  @Post("cycles")
  @HttpCode(201)
  @RequirePermission("hr:performance:manage")
  createCycle(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createFeedbackCycleSchema)) body: CreateFeedbackCycleInput,
  ) {
    return this.service.createCycle(u.orgId, u.userId, body);
  }

  @Get("cycles/:cycleId")
  @RequirePermission("hr:performance:view")
  getCycle(@CurrentUser() u: CurrentUserContext, @Param("cycleId", ParseIntPipe) cycleId: number) {
    return this.service.getCycle(u.orgId, cycleId);
  }

  @Patch("cycles/:cycleId")
  @RequirePermission("hr:performance:manage")
  updateCycleStatus(
    @CurrentUser() u: CurrentUserContext,
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @Body(new ZodValidationPipe(updateCycleStatusSchema)) body: UpdateCycleStatusInput,
  ) {
    return this.service.updateCycleStatus(u.orgId, cycleId, body.status);
  }

  @Get("my-reviews")
  @RequirePermission("hr:performance:view")
  getMyPendingReviews(@CurrentUser() u: CurrentUserContext) {
    return this.service.getMyPendingReviews(u.orgId, u.userId);
  }

  @Post("requests/:requestId/respond")
  @HttpCode(200)
  @RequirePermission("hr:performance:view")
  submitResponse(
    @CurrentUser() u: CurrentUserContext,
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body(new ZodValidationPipe(submitFeedbackResponseSchema)) body: SubmitFeedbackResponseInput,
  ) {
    return this.service.submitResponse(u.orgId, u.userId, requestId, body);
  }

  @Get("results/:subjectId")
  @RequirePermission("hr:performance:view")
  getResults(@CurrentUser() u: CurrentUserContext, @Param("subjectId") subjectId: string) {
    return this.service.getResults(u.orgId, subjectId);
  }
}
