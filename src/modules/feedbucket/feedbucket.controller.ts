import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { readRequestScope } from "../organization/core/read-request-scope";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { FeedbucketWidgetsService } from "./feedbucket-widgets.service";
import { FeedbucketSubmissionsService } from "./feedbucket-submissions.service";
import { FeedbucketAiService } from "./feedbucket-ai.service";
import { ProjectsTicketsService } from "../build/core/projects-tickets.service";
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
import { analyzeBodySchema, type AnalyzeBodyInput } from "./feedbucket-ai.schemas";
import { z } from "zod";
import { Validate } from "../../common/validation/validate.decorator";

const widgetIdParams = z.object({ widgetId: z.coerce.number().int().positive() }).strict();
const submissionIdParams = z.object({ submissionId: z.coerce.number().int().positive() }).strict();

@RequireModule("feedbucket")
@Controller("feedbucket")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class FeedbucketController {
  constructor(
    private readonly widgets: FeedbucketWidgetsService,
    private readonly submissions: FeedbucketSubmissionsService,
    private readonly tickets: ProjectsTicketsService,
    private readonly feedbucketAi: FeedbucketAiService,
  ) {}

  @Get("widgets")
  @RequirePermission("feedbucket:widgets:view")
  listWidgets(@CurrentUser() user: CurrentUserContext) {
    return this.widgets.list(user.orgId);
  }

  @Post("widgets")
  @RequirePermission("feedbucket:widgets:create")
  @HttpCode(201)
  @Validate({ body: createWidgetSchema })
  createWidget(
    @CurrentUser() user: CurrentUserContext,
    @Body() dto: CreateWidgetInput,
  ) {
    return this.widgets.create(user.orgId, user.userId, dto);
  }

  @Get("widgets/:widgetId")
  @RequirePermission("feedbucket:widgets:view")
  @Validate({ params: widgetIdParams })
  getWidget(
    @CurrentUser() user: CurrentUserContext,
    @Param("widgetId", ParseIntPipe) widgetId: number,
  ) {
    return this.widgets.findOne(user.orgId, widgetId);
  }

  @Patch("widgets/:widgetId")
  @RequirePermission("feedbucket:widgets:update")
  @Validate({ params: widgetIdParams, body: updateWidgetSchema })
  updateWidget(
    @CurrentUser() user: CurrentUserContext,
    @Param("widgetId", ParseIntPipe) widgetId: number,
    @Body() dto: UpdateWidgetInput,
  ) {
    return this.widgets.update(user.orgId, widgetId, dto);
  }

  @Delete("widgets/:widgetId")
  @RequirePermission("feedbucket:widgets:delete")
  @Validate({ params: widgetIdParams })
  deleteWidget(
    @CurrentUser() user: CurrentUserContext,
    @Param("widgetId", ParseIntPipe) widgetId: number,
  ) {
    return this.widgets.softDelete(user.orgId, widgetId);
  }

  @Post("widgets/:widgetId/rotate-key")
  @RequirePermission("feedbucket:widgets:manage")
  @HttpCode(200)
  @Validate({ params: widgetIdParams })
  rotateKey(
    @CurrentUser() user: CurrentUserContext,
    @Param("widgetId", ParseIntPipe) widgetId: number,
  ) {
    return this.widgets.rotateKey(user.orgId, widgetId);
  }

  @Get("submissions")
  @RequirePermission("feedbucket:submissions:view")
  @Validate({ query: listSubmissionsQuerySchema })
  listSubmissions(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ListSubmissionsQuery,
    @Req() req: Request,
  ) {
    const scope = readRequestScope(req);
    return this.submissions.list(user.orgId, user.userId, query, scope);
  }

  @Get("submissions/:submissionId")
  @RequirePermission("feedbucket:submissions:view")
  @Validate({ params: submissionIdParams })
  getSubmission(
    @CurrentUser() user: CurrentUserContext,
    @Param("submissionId", ParseIntPipe) submissionId: number,
  ) {
    return this.submissions.findOne(user.orgId, submissionId);
  }

  @Patch("submissions/:submissionId")
  @RequirePermission("feedbucket:submissions:update")
  @Validate({ params: submissionIdParams, body: updateSubmissionSchema })
  updateSubmission(
    @CurrentUser() user: CurrentUserContext,
    @Param("submissionId", ParseIntPipe) submissionId: number,
    @Body() dto: UpdateSubmissionInput,
  ) {
    return this.submissions.update(user.orgId, submissionId, dto);
  }

  @Delete("submissions/:submissionId")
  @RequirePermission("feedbucket:submissions:delete")
  @Validate({ params: submissionIdParams })
  deleteSubmission(
    @CurrentUser() user: CurrentUserContext,
    @Param("submissionId", ParseIntPipe) submissionId: number,
  ) {
    return this.submissions.softDelete(user.orgId, submissionId);
  }

  @Post("submissions/:submissionId/convert-to-ticket")
  @RequirePermission("feedbucket:submissions:manage")
  @HttpCode(201)
  @Validate({ params: submissionIdParams })
  convertToTicket(
    @CurrentUser() user: CurrentUserContext,
    @Param("submissionId", ParseIntPipe) submissionId: number,
  ) {
    return this.submissions.convertToTicket(user.orgId, user.userId, submissionId, this.tickets);
  }

  @Post("submissions/:submissionId/ai-analyze")
  @RequirePermission("feedbucket:submissions:ai")
  @HttpCode(200)
  @Validate({ params: submissionIdParams, body: analyzeBodySchema })
  analyzeSubmission(
    @CurrentUser() user: CurrentUserContext,
    @Param("submissionId", ParseIntPipe) submissionId: number,
    @Body() body: AnalyzeBodyInput,
  ) {
    return this.feedbucketAi.analyze(user, submissionId, body.force ?? false);
  }

  @Post("submissions/:submissionId/ai-create-ticket")
  @RequirePermission("feedbucket:submissions:manage")
  @HttpCode(201)
  @Validate({ params: submissionIdParams })
  createTicketFromAnalysis(
    @CurrentUser() user: CurrentUserContext,
    @Param("submissionId", ParseIntPipe) submissionId: number,
  ) {
    return this.feedbucketAi.createTicketFromAnalysis(user, submissionId);
  }

  @Get("stats")
  @RequirePermission("feedbucket:submissions:view")
  getStats(@CurrentUser() user: CurrentUserContext, @Req() req: Request) {
    const scope = readRequestScope(req);
    return this.submissions.stats(user.orgId, user.userId, scope);
  }
}
