import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { FeedbucketWidgetsService } from "./feedbucket-widgets.service";
import { FeedbucketSubmissionsService } from "./feedbucket-submissions.service";
import { ProjectsTicketsService } from "../projects/projects-tickets.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  createWidgetSchema,
  listSubmissionsQuerySchema,
  updateSubmissionSchema,
  updateWidgetSchema,
  type CreateWidgetInput,
  type ListSubmissionsQuery,
  type UpdateSubmissionInput,
  type UpdateWidgetInput,
} from "./feedbucket.schemas";

@Controller("feedbucket")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class FeedbucketController {
  constructor(
    private readonly widgets: FeedbucketWidgetsService,
    private readonly submissions: FeedbucketSubmissionsService,
    private readonly tickets: ProjectsTicketsService,
  ) {}

  @Get("widgets")
  @RequirePermission("feedbucket:widgets:view")
  listWidgets(@CurrentUser() user: CurrentUserContext) {
    return this.widgets.list(user.orgId);
  }

  @Post("widgets")
  @RequirePermission("feedbucket:widgets:create")
  createWidget(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(createWidgetSchema)) dto: CreateWidgetInput,
  ) {
    return this.widgets.create(user.orgId, user.userId, dto);
  }

  @Get("widgets/:widgetId")
  @RequirePermission("feedbucket:widgets:view")
  getWidget(
    @CurrentUser() user: CurrentUserContext,
    @Param("widgetId", ParseIntPipe) widgetId: number,
  ) {
    return this.widgets.findOne(user.orgId, widgetId);
  }

  @Patch("widgets/:widgetId")
  @RequirePermission("feedbucket:widgets:update")
  updateWidget(
    @CurrentUser() user: CurrentUserContext,
    @Param("widgetId", ParseIntPipe) widgetId: number,
    @Body(new ZodValidationPipe(updateWidgetSchema)) dto: UpdateWidgetInput,
  ) {
    return this.widgets.update(user.orgId, widgetId, dto);
  }

  @Delete("widgets/:widgetId")
  @RequirePermission("feedbucket:widgets:delete")
  deleteWidget(
    @CurrentUser() user: CurrentUserContext,
    @Param("widgetId", ParseIntPipe) widgetId: number,
  ) {
    return this.widgets.softDelete(user.orgId, widgetId);
  }

  @Post("widgets/:widgetId/rotate-key")
  @RequirePermission("feedbucket:widgets:manage")
  rotateKey(
    @CurrentUser() user: CurrentUserContext,
    @Param("widgetId", ParseIntPipe) widgetId: number,
  ) {
    return this.widgets.rotateKey(user.orgId, widgetId);
  }

  @Get("submissions")
  @RequirePermission("feedbucket:submissions:view")
  listSubmissions(
    @CurrentUser() user: CurrentUserContext,
    @Query(new ZodValidationPipe(listSubmissionsQuerySchema)) query: ListSubmissionsQuery,
    @Req() req: Request,
  ) {
    const scope = req.rbacScope ?? "all";
    return this.submissions.list(user.orgId, user.userId, query, scope);
  }

  @Get("submissions/:submissionId")
  @RequirePermission("feedbucket:submissions:view")
  getSubmission(
    @CurrentUser() user: CurrentUserContext,
    @Param("submissionId", ParseIntPipe) submissionId: number,
  ) {
    return this.submissions.findOne(user.orgId, submissionId);
  }

  @Patch("submissions/:submissionId")
  @RequirePermission("feedbucket:submissions:update")
  updateSubmission(
    @CurrentUser() user: CurrentUserContext,
    @Param("submissionId", ParseIntPipe) submissionId: number,
    @Body(new ZodValidationPipe(updateSubmissionSchema)) dto: UpdateSubmissionInput,
  ) {
    return this.submissions.update(user.orgId, submissionId, dto);
  }

  @Delete("submissions/:submissionId")
  @RequirePermission("feedbucket:submissions:delete")
  deleteSubmission(
    @CurrentUser() user: CurrentUserContext,
    @Param("submissionId", ParseIntPipe) submissionId: number,
  ) {
    return this.submissions.softDelete(user.orgId, submissionId);
  }

  @Post("submissions/:submissionId/convert-to-ticket")
  @RequirePermission("feedbucket:submissions:manage")
  convertToTicket(
    @CurrentUser() user: CurrentUserContext,
    @Param("submissionId", ParseIntPipe) submissionId: number,
  ) {
    return this.submissions.convertToTicket(user.orgId, user.userId, submissionId, this.tickets);
  }

  @Get("stats")
  @RequirePermission("feedbucket:submissions:view")
  getStats(@CurrentUser() user: CurrentUserContext) {
    return this.submissions.stats(user.orgId);
  }
}
