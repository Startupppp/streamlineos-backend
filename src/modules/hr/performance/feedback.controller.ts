import { Controller, Get, HttpCode, Post, Patch, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { FeedbackService } from "./feedback.service";
import {
  createFeedbackCycleSchema,
  updateCycleStatusSchema,
  submitFeedbackResponseSchema,
  type CreateFeedbackCycleInput,
  type UpdateCycleStatusInput,
  type SubmitFeedbackResponseInput,
} from "./dto/feedback.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts"
import { listCyclesResponseSchema, createCycleResponseSchema, getCycleResponseSchema, updateCycleStatusResponseSchema, getMyPendingReviewsResponseSchema, submitResponseResponseSchema, getResultsResponseSchema } from "./dto/feedback-response.schemas"

const cycleIdParams = z.object({ cycleId: z.coerce.number().int().positive() }).strict();
const requestIdParams = z.object({ requestId: z.coerce.number().int().positive() }).strict();
const subjectIdParams = z.object({ subjectId: z.string().min(1) }).strict();

@RequireModule("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller("hr/feedback")
export class FeedbackController {
  constructor(private readonly service: FeedbackService) {}

  @ResponseSchema(listCyclesResponseSchema)
  @Get("cycles")
  @RequirePermission("hr:performance:view")
  listCycles(@CurrentUser() u: CurrentUserContext) {
    return this.service.listCycles(u.orgId);
  }

  @ResponseSchema(createCycleResponseSchema)
  @Post("cycles")
  @HttpCode(201)
  @RequirePermission("hr:performance:manage")
  @Validate({ body: createFeedbackCycleSchema })
  createCycle(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateFeedbackCycleInput,
  ) {
    return this.service.createCycle(u.orgId, u.userId, body);
  }

  @ResponseSchema(getCycleResponseSchema)
  @Get("cycles/:cycleId")
  @RequirePermission("hr:performance:view")
  @Validate({ params: cycleIdParams })
  getCycle(@CurrentUser() u: CurrentUserContext, @Param("cycleId", ParseIntPipe) cycleId: number) {
    return this.service.getCycle(u.orgId, cycleId);
  }

  @ResponseSchema(updateCycleStatusResponseSchema)
  @Patch("cycles/:cycleId")
  @RequirePermission("hr:performance:manage")
  @Validate({ params: cycleIdParams, body: updateCycleStatusSchema })
  updateCycleStatus(
    @CurrentUser() u: CurrentUserContext,
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @Body() body: UpdateCycleStatusInput,
  ) {
    return this.service.updateCycleStatus(u.orgId, cycleId, body.status);
  }

  @ResponseSchema(getMyPendingReviewsResponseSchema)
  @Get("my-reviews")
  @RequirePermission("hr:performance:view")
  getMyPendingReviews(@CurrentUser() u: CurrentUserContext) {
    return this.service.getMyPendingReviews(u.orgId, u.userId);
  }

  @ResponseSchema(submitResponseResponseSchema)
  @Post("requests/:requestId/respond")
  @HttpCode(200)
  @RequirePermission("hr:performance:view")
  @Validate({ params: requestIdParams, body: submitFeedbackResponseSchema })
  submitResponse(
    @CurrentUser() u: CurrentUserContext,
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body() body: SubmitFeedbackResponseInput,
  ) {
    return this.service.submitResponse(u.orgId, u.userId, requestId, body);
  }

  @ResponseSchema(getResultsResponseSchema)
  @Get("results/:subjectId")
  @RequirePermission("hr:performance:view")
  @Validate({ params: subjectIdParams })
  getResults(@CurrentUser() u: CurrentUserContext, @Param("subjectId") subjectId: string) {
    return this.service.getResults(u.orgId, subjectId);
  }
}
