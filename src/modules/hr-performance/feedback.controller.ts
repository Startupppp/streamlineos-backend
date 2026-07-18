import { Controller, Get, HttpCode, Post, Patch, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { FeedbackService } from "./feedback.service";

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
  @RequirePermission("hr:performance:manage")
  createCycle(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: Parameters<FeedbackService["createCycle"]>[2],
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
    @Body() body: { status: string },
  ) {
    return this.service.updateCycleStatus(u.orgId, cycleId, body.status);
  }

  @Get("my-reviews")
  @RequirePermission("hr:performance:view")
  getMyPendingReviews(@CurrentUser() u: CurrentUserContext) {
    return this.service.getMyPendingReviews(u.userId);
  }

  @Post("requests/:requestId/respond")
  @RequirePermission("hr:performance:view")
  submitResponse(
    @CurrentUser() u: CurrentUserContext,
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body() body: Parameters<FeedbackService["submitResponse"]>[2],
  ) {
    return this.service.submitResponse(u.userId, requestId, body);
  }

  @Get("results/:subjectId")
  @RequirePermission("hr:performance:view")
  getResults(@CurrentUser() u: CurrentUserContext, @Param("subjectId") subjectId: string) {
    return this.service.getResults(u.orgId, subjectId);
  }
}
