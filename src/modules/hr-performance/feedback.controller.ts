import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { FeedbackService } from "./feedback.service";

@UseGuards(JwtAuthGuard)
@Controller("hr/feedback")
export class FeedbackController {
  constructor(private readonly service: FeedbackService) {}

  @Get("cycles")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:performance:view")
  listCycles(@CurrentUser() u: CurrentUserContext) {
    return this.service.listCycles(u.orgId);
  }

  @Post("cycles")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:performance:manage")
  createCycle(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: Parameters<FeedbackService["createCycle"]>[2],
  ) {
    return this.service.createCycle(u.orgId, u.userId, body);
  }

  @Get("cycles/:id")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:performance:view")
  getCycle(@CurrentUser() u: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.service.getCycle(u.orgId, id);
  }

  @Patch("cycles/:id")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:performance:manage")
  updateCycleStatus(
    @CurrentUser() u: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { status: string },
  ) {
    return this.service.updateCycleStatus(u.orgId, id, body.status);
  }

  @Get("my-reviews")
  getMyPendingReviews(@CurrentUser() u: CurrentUserContext) {
    return this.service.getMyPendingReviews(u.userId);
  }

  @Post("requests/:requestId/respond")
  submitResponse(
    @CurrentUser() u: CurrentUserContext,
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body() body: Parameters<FeedbackService["submitResponse"]>[2],
  ) {
    return this.service.submitResponse(u.userId, requestId, body);
  }

  @Get("results/:subjectId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:performance:view")
  getResults(@CurrentUser() u: CurrentUserContext, @Param("subjectId") subjectId: string) {
    return this.service.getResults(u.orgId, subjectId);
  }
}
