import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { Universal } from "../../../common/auth/universal.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { ReportingManagerRequestsService } from "./reporting-manager-requests.service";
import {
  createReportingManagerRequestSchema,
  listMyReportingManagerRequestsSchema,
  myManagerCandidatesQuerySchema,
  myReportingManagerRequestPageSchema,
  myReportingManagerRequestSchema,
  respondReportingManagerRequestSchema,
  type CreateReportingManagerRequestInput,
  type ListMyReportingManagerRequestsInput,
  type MyManagerCandidatesQuery,
  type RespondReportingManagerRequestInput,
} from "./dto/reporting-lines-requests.schemas";
import { managerCandidatesResponseSchema, reportingManagerRequestIdParamsSchema } from "./dto/reporting-lines-shared.schemas";

/** Self-service: every query is keyed on the caller's own user id in the service, never on input. */
@RequireModule("hr")
@Controller("me/reporting-manager-requests")
@UseGuards(JwtAuthGuard)
export class MyReportingManagerRequestsController {
  constructor(private readonly requests: ReportingManagerRequestsService) {}

  @Post()
  @Universal()
  @Idempotent("self.reporting-manager-requests.create")
  @HttpCode(201)
  @Validate({ body: createReportingManagerRequestSchema })
  @ResponseSchema(myReportingManagerRequestSchema)
  create(@Body() body: CreateReportingManagerRequestInput, @CurrentUser() actor: CurrentUserContext) {
    return this.requests.create(actor, body);
  }

  @Get()
  @Universal()
  @Validate({ query: listMyReportingManagerRequestsSchema })
  @ResponseSchema(myReportingManagerRequestPageSchema)
  list(@Query() query: ListMyReportingManagerRequestsInput, @CurrentUser() actor: CurrentUserContext) {
    return this.requests.listMine(actor, query);
  }

  @Get("manager-candidates")
  @Universal()
  @Validate({ query: myManagerCandidatesQuerySchema })
  @ResponseSchema(managerCandidatesResponseSchema)
  candidates(@Query() query: MyManagerCandidatesQuery, @CurrentUser() actor: CurrentUserContext) {
    return this.requests.myCandidates(actor, query);
  }

  @Post(":requestId/cancel")
  @Universal()
  @Idempotent("self.reporting-manager-requests.cancel")
  @HttpCode(200)
  @Validate({ params: reportingManagerRequestIdParamsSchema })
  @BodylessAction()
  @ResponseSchema(myReportingManagerRequestSchema)
  cancel(@Param("requestId") requestId: string, @CurrentUser() actor: CurrentUserContext) {
    return this.requests.cancelMine(actor, requestId);
  }

  @Post(":requestId/respond")
  @Universal()
  @Idempotent("self.reporting-manager-requests.respond")
  @HttpCode(200)
  @Validate({ params: reportingManagerRequestIdParamsSchema, body: respondReportingManagerRequestSchema })
  @ResponseSchema(myReportingManagerRequestSchema)
  respond(
    @Param("requestId") requestId: string,
    @Body() body: RespondReportingManagerRequestInput,
    @CurrentUser() actor: CurrentUserContext,
  ) {
    return this.requests.respondMine(actor, requestId, body);
  }
}
