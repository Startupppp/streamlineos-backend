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
import { readRequestScopedRead } from "../organization/core/read-request-scope";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { FeedbucketWidgetsService } from "./feedbucket-widgets.service";
import { FeedbucketSubmissionsService } from "./feedbucket-submissions.service";
import { FeedbucketAiService } from "./feedbucket-ai.service";
import { ProjectsTicketsCreateService } from "../build/core/tickets/projects-tickets-create.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { actingMembershipId } from "../../common/auth/principal";
import {
  bulkSubmissionsSchema,
  convertToTicketSchema,
  createWidgetSchema,
  feedbucketMediaKindSchema,
  listSubmissionsQuerySchema,
  updateSubmissionSchema,
  updateWidgetSchema,
  type BulkSubmissionsInput,
  type ConvertToTicketInput,
  type CreateWidgetInput,
  type FeedbucketMediaKind,
  type ListSubmissionsQuery,
  type UpdateSubmissionInput,
  type UpdateWidgetInput,
} from "./feedbucket.schemas";
import {
  analyzeBodySchema,
  type AnalyzeBodyInput,
} from "./feedbucket-ai.schemas";
import { z } from "zod";
import { Validate } from "../../common/validation/validate.decorator";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import {
  BodylessAction,
  ResponseSchema,
} from "../../common/openapi/zod-operation-contracts";
import {
  feedbucketWidgetListSchema,
  feedbucketWidgetWithProjectSchema,
  feedbucketRotateKeySchema,
  feedbucketSubmissionListSchema,
  feedbucketBulkSubmissionsSchema,
  feedbucketSubmissionDetailSchema,
  feedbucketSubmissionRowSchema,
  feedbucketConvertTicketSchema,
  feedbucketFeedbackAnalysisSchema,
  feedbucketCreateTicketFromAnalysisSchema,
  feedbucketStatsSchema,
  successSchema,
} from "./dto/feedbucket-response.schemas";

const widgetIdParams = z
  .object({ widgetId: z.coerce.number().int().positive() })
  .strict();
const submissionIdParams = z
  .object({ submissionId: z.coerce.number().int().positive() })
  .strict();
const submissionMediaParams = submissionIdParams
  .extend({ mediaKind: feedbucketMediaKindSchema })
  .strict();

@RequireModule("feedbucket")
@Controller("feedbucket")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class FeedbucketController {
  constructor(
    private readonly widgets: FeedbucketWidgetsService,
    private readonly feedbucketAi: FeedbucketAiService,
    private readonly tickets: ProjectsTicketsCreateService,
    private readonly submissions: FeedbucketSubmissionsService,
  ) {}

  @Get("widgets")
  @RequirePermission("feedbucket:widgets:view")
  @ResponseSchema(feedbucketWidgetListSchema)
  listWidgets(@CurrentUser() user: CurrentUserContext) {
    return this.widgets.list(user.orgId);
  }

  @Post("widgets")
  @RequirePermission("feedbucket:widgets:create")
  @HttpCode(201)
  @Validate({ body: createWidgetSchema })
  @ResponseSchema(feedbucketWidgetWithProjectSchema)
  createWidget(
    @CurrentUser() user: CurrentUserContext,
    @Body() dto: CreateWidgetInput,
  ) {
    return this.widgets.create(user.orgId, user.userId, dto);
  }

  @Get("widgets/:widgetId")
  @RequirePermission("feedbucket:widgets:view")
  @Validate({ params: widgetIdParams })
  @ResponseSchema(feedbucketWidgetWithProjectSchema)
  getWidget(
    @CurrentUser() user: CurrentUserContext,
    @Param("widgetId", ParseIntPipe) widgetId: number,
  ) {
    return this.widgets.findOne(user.orgId, widgetId);
  }

  @Patch("widgets/:widgetId")
  @RequirePermission("feedbucket:widgets:update")
  @Validate({ params: widgetIdParams, body: updateWidgetSchema })
  @ResponseSchema(feedbucketWidgetWithProjectSchema)
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
  @ResponseSchema(successSchema)
  async deleteWidget(
    @CurrentUser() user: CurrentUserContext,
    @Param("widgetId", ParseIntPipe) widgetId: number,
  ) {
    await this.widgets.softDelete(user.orgId, widgetId);
    return { success: true as const };
  }

  @Post("widgets/:widgetId/rotate-key")
  @BodylessAction()
  @RequirePermission("feedbucket:widgets:manage")
  @HttpCode(200)
  @Validate({ params: widgetIdParams })
  @ResponseSchema(feedbucketRotateKeySchema)
  rotateKey(
    @CurrentUser() user: CurrentUserContext,
    @Param("widgetId", ParseIntPipe) widgetId: number,
  ) {
    return this.widgets.rotateKey(user.orgId, widgetId);
  }

  @Get("submissions")
  @RequirePermission("feedbucket:submissions:view")
  @Validate({ query: listSubmissionsQuerySchema })
  @ResponseSchema(feedbucketSubmissionListSchema)
  listSubmissions(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ListSubmissionsQuery,
    @Req() req: Request,
  ) {
    const read = readRequestScopedRead(req, user);
    return this.submissions.list(
      read,
      query,
      actingMembershipId(user.principal),
    );
  }

  @Post("submissions/bulk")
  @RequirePermission("feedbucket:submissions:update")
  @HttpCode(200)
  @Idempotent("feedbucket.submissions.bulk-update")
  @Validate({ body: bulkSubmissionsSchema })
  @ResponseSchema(feedbucketBulkSubmissionsSchema)
  bulkUpdateSubmissions(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: BulkSubmissionsInput,
    @Req() req: Request,
  ) {
    const read = readRequestScopedRead(req, user);
    return this.submissions.bulkMutate(
      read,
      user,
      body,
      actingMembershipId(user.principal),
    );
  }

  @Get("submissions/:submissionId")
  @RequirePermission("feedbucket:submissions:view")
  @Validate({ params: submissionIdParams })
  @ResponseSchema(feedbucketSubmissionDetailSchema)
  getSubmission(
    @CurrentUser() user: CurrentUserContext,
    @Param("submissionId", ParseIntPipe) submissionId: number,
  ) {
    return this.submissions.findOne(user.orgId, submissionId);
  }

  @Patch("submissions/:submissionId")
  @RequirePermission("feedbucket:submissions:update")
  @Validate({ params: submissionIdParams, body: updateSubmissionSchema })
  @ResponseSchema(feedbucketSubmissionRowSchema)
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
  @ResponseSchema(successSchema)
  async deleteSubmission(
    @CurrentUser() user: CurrentUserContext,
    @Param("submissionId", ParseIntPipe) submissionId: number,
  ) {
    await this.submissions.softDelete(user.orgId, submissionId);
    return { success: true as const };
  }

  @Delete("submissions/:submissionId/media/:mediaKind")
  @RequirePermission("feedbucket:submissions:delete")
  @Validate({ params: submissionMediaParams })
  @ResponseSchema(successSchema)
  async deleteSubmissionMedia(
    @CurrentUser() user: CurrentUserContext,
    @Param("submissionId", ParseIntPipe) submissionId: number,
    @Param("mediaKind") mediaKind: FeedbucketMediaKind,
  ) {
    await this.submissions.deleteMedia(user.orgId, submissionId, mediaKind);
    return { success: true as const };
  }

  @Post("submissions/:submissionId/convert-to-ticket")
  @RequirePermission("feedbucket:submissions:manage")
  @HttpCode(201)
  @Validate({ params: submissionIdParams, body: convertToTicketSchema })
  @ResponseSchema(feedbucketConvertTicketSchema)
  convertToTicket(
    @CurrentUser() user: CurrentUserContext,
    @Param("submissionId", ParseIntPipe) submissionId: number,
    @Body() body: ConvertToTicketInput,
  ) {
    return this.submissions.convertToTicket(
      user,
      submissionId,
      this.tickets,
      body,
    );
  }

  @Post("submissions/:submissionId/ai-analyze")
  @RequirePermission("feedbucket:submissions:ai")
  @HttpCode(200)
  @Validate({ params: submissionIdParams, body: analyzeBodySchema })
  @ResponseSchema(feedbucketFeedbackAnalysisSchema)
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
  @Validate({ params: submissionIdParams, body: convertToTicketSchema })
  @ResponseSchema(feedbucketCreateTicketFromAnalysisSchema)
  createTicketFromAnalysis(
    @CurrentUser() user: CurrentUserContext,
    @Param("submissionId", ParseIntPipe) submissionId: number,
    @Body() body: ConvertToTicketInput,
  ) {
    return this.feedbucketAi.createTicketFromAnalysis(user, submissionId, body);
  }

  @Get("stats")
  @RequirePermission("feedbucket:submissions:view")
  @ResponseSchema(feedbucketStatsSchema)
  getStats(@CurrentUser() user: CurrentUserContext, @Req() req: Request) {
    const read = readRequestScopedRead(req, user);
    return this.submissions.stats(read, actingMembershipId(user.principal));
  }
}
