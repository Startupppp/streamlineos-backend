import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Put,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { HrInterviewsService } from "./hr-interviews.service";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import {
  interviewListSchema,
  upsertSlaSchema,
  type InterviewListInput,
  type UpsertSlaInput,
} from "./dto/hr-interviews.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  interviewListResponseSchema,
  interviewStatsSchema,
  interviewSlaSchema,
  slaReportResponseSchema,
  scorecardSummaryResponseSchema,
} from "./dto/interviews-response.schemas";

const interviewIdParams = z.object({ interviewId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/recruitment/interviews")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrInterviewsController {
  constructor(private readonly interviews: HrInterviewsService) {}

  @Get()
  @ResponseSchema(interviewListResponseSchema)
  @RequirePermission("hr:interviews:view")
  @Validate({ query: interviewListSchema })
  list(
    @Query() query: InterviewListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.interviews.list(u.orgId, query);
  }

  @Get("stats")
  @ResponseSchema(interviewStatsSchema)
  @RequirePermission("hr:interviews:view")
  stats(@CurrentUser() u: CurrentUserContext) {
    return this.interviews.stats(u.orgId);
  }

  @Get("slas")
  @ResponseSchema(z.array(interviewSlaSchema))
  @RequirePermission("hr:interviews:view")
  listSlas(@CurrentUser() u: CurrentUserContext) {
    return this.interviews.listSlas(u.orgId);
  }

  @Put("slas")
  @ResponseSchema(interviewSlaSchema)
  @RequirePermission("hr:interviews:manage")
  @Validate({ body: upsertSlaSchema })
  upsertSla(@Body() body: UpsertSlaInput, @CurrentUser() u: CurrentUserContext) {
    return this.interviews.upsertSla(u.orgId, body);
  }

  @Get("sla-report")
  @ResponseSchema(slaReportResponseSchema)
  @RequirePermission("hr:interviews:view")
  slaReport(@CurrentUser() u: CurrentUserContext) {
    return this.interviews.slaReport(u.orgId);
  }

  @Get(":interviewId/scorecard/summary")
  @ResponseSchema(scorecardSummaryResponseSchema)
  @RequirePermission("hr:interviews:view")
  @Validate({ params: interviewIdParams })
  async scorecardSummary(@Param("interviewId", ParseIntPipe) interviewId: number, @CurrentUser() u: CurrentUserContext) {
    const result = await this.interviews.scorecardSummary(u.orgId, interviewId);
    if (!result) throw new NotFoundException("Interview not found.");
    return result;
  }

  @Get(":interviewId/ics")
  @ApiOkResponse({ description: "ICS calendar file", content: { "text/calendar": { schema: { type: "string" } } } })
  @RequirePermission("hr:interviews:view")
  @Validate({ params: interviewIdParams })
  async ics(
    @Param("interviewId", ParseIntPipe) interviewId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const result = await this.interviews.buildIcs(u.orgId, interviewId);
    if (!result) throw new NotFoundException("Interview not found.");

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${result.fileName}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(result.ics);
  }
}
