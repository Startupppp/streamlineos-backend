import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Put,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrInterviewsService } from "./hr-interviews.service";
import { RECRUITMENT_ADMIN_ROLES } from "./recruitment-roles";
import { upsertSlaSchema, type UpsertSlaInput } from "./dto/hr-interviews.schemas";

@Controller("hr/recruitment/interviews")
@UseGuards(JwtAuthGuard)
export class HrInterviewsController {
  constructor(private readonly interviews: HrInterviewsService) {}

  @Get("slas")
  listSlas(@CurrentUser() u: CurrentUserContext) {
    return this.interviews.listSlas(u.orgId);
  }

  @Put("slas")
  upsertSla(
    @Body(new ZodValidationPipe(upsertSlaSchema)) body: UpsertSlaInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_ADMIN_ROLES.includes(u.role)) {
      throw new ForbiddenException("Forbidden");
    }
    return this.interviews.upsertSla(u.orgId, body);
  }

  @Get("sla-report")
  slaReport(@CurrentUser() u: CurrentUserContext) {
    return this.interviews.slaReport(u.orgId);
  }

  @Get(":interviewId/scorecard/summary")
  async scorecardSummary(
    @Param("interviewId", ParseIntPipe) interviewId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!RECRUITMENT_ADMIN_ROLES.includes(u.role)) {
      throw new ForbiddenException("Forbidden");
    }
    const result = await this.interviews.scorecardSummary(u.orgId, interviewId);
    if (!result) throw new NotFoundException("Interview not found.");
    return result;
  }

  @Get(":interviewId/ics")
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
