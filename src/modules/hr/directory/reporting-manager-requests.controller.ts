import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { ReportingManagerRequestsService } from "./reporting-manager-requests.service";
import {
  hrReportingManagerRequestPageSchema,
  hrReportingManagerRequestSchema,
  listReportingManagerRequestsSchema,
  reviewReportingManagerRequestResponseSchema,
  reviewReportingManagerRequestSchema,
  type ListReportingManagerRequestsInput,
  type ReviewReportingManagerRequestInput,
} from "./dto/reporting-lines-requests.schemas";
import { reportingManagerRequestIdParamsSchema } from "./dto/reporting-lines-shared.schemas";

@RequireModule("hr")
@Controller("hr/reporting-manager-requests")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ReportingManagerRequestsController {
  constructor(private readonly requests: ReportingManagerRequestsService) {}

  @Get()
  @RequirePermission("hr:reporting-lines:review")
  @Validate({ query: listReportingManagerRequestsSchema })
  @ResponseSchema(hrReportingManagerRequestPageSchema)
  list(@Query() query: ListReportingManagerRequestsInput, @CurrentUser() actor: CurrentUserContext) {
    return this.requests.listForReview(actor, query);
  }

  @Get(":requestId")
  @RequirePermission("hr:reporting-lines:review")
  @Validate({ params: reportingManagerRequestIdParamsSchema })
  @ResponseSchema(hrReportingManagerRequestSchema)
  get(@Param("requestId") requestId: string, @CurrentUser() actor: CurrentUserContext) {
    return this.requests.getForReview(actor, requestId);
  }

  @Post(":requestId/review")
  @RequirePermission("hr:reporting-lines:review")
  @Idempotent("hr.reporting-manager-requests.review")
  @HttpCode(200)
  @Validate({ params: reportingManagerRequestIdParamsSchema, body: reviewReportingManagerRequestSchema })
  @ResponseSchema(reviewReportingManagerRequestResponseSchema)
  review(
    @Param("requestId") requestId: string,
    @Body() body: ReviewReportingManagerRequestInput,
    @CurrentUser() actor: CurrentUserContext,
  ) {
    return this.requests.review(actor, requestId, body);
  }
}
