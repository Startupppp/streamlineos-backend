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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { HrInterviewSchedulingService } from "./hr-interview-scheduling.service";
import { HrInterviewResultsService } from "./hr-interview-results.service";
import {
  createInterviewSchema,
  scheduleInterviewSchema,
  selfScheduleSchema,
  submitScorecardSchema,
  updateInterviewSchema,
  type CreateInterviewInput,
  type ScheduleInterviewInput,
  type SelfScheduleInput,
  type SubmitScorecardInput,
  type UpdateInterviewInput,
} from "./dto/interview-scheduling.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const interviewIdParams = z.object({ interviewId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/recruitment/interviews")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrInterviewSchedulingController {
  constructor(
    private readonly scheduling: HrInterviewSchedulingService,
    private readonly results: HrInterviewResultsService,
  ) {}

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:interviews:manage")
  create(@Body(new ZodValidationPipe(createInterviewSchema)) body: CreateInterviewInput, @CurrentUser() u: CurrentUserContext) {
    return this.scheduling.createInterview(u.orgId, body);
  }

  @Post("schedule")
  @HttpCode(201)
  @RequirePermission("hr:interviews:manage")
  schedule(@Body(new ZodValidationPipe(scheduleInterviewSchema)) body: ScheduleInterviewInput, @CurrentUser() u: CurrentUserContext) {
    return this.scheduling.scheduleInterview(u.orgId, u.userId, body);
  }

  @Post("self-schedule")
  @HttpCode(201)
  @RequirePermission("hr:interviews:manage")
  selfSchedule(@Body(new ZodValidationPipe(selfScheduleSchema)) body: SelfScheduleInput, @CurrentUser() u: CurrentUserContext) {
    return this.scheduling.selfSchedule(u.orgId, u.userId, body);
  }

  @Patch(":interviewId")
  @RequirePermission("hr:interviews:manage")
  @Validate({ params: interviewIdParams })
  update(
    @Param("interviewId", ParseIntPipe) interviewId: number,
    @Body(new ZodValidationPipe(updateInterviewSchema)) body: UpdateInterviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.results.updateInterview(u.orgId, interviewId, body);
  }

  @Delete(":interviewId")
  @RequirePermission("hr:interviews:manage")
  @Validate({ params: interviewIdParams })
  remove(@Param("interviewId", ParseIntPipe) interviewId: number, @CurrentUser() u: CurrentUserContext) {
    return this.scheduling.deleteInterview(u.orgId, interviewId);
  }

  @Get(":interviewId/scorecard")
  @RequirePermission("hr:interviews:view")
  @Validate({ params: interviewIdParams })
  getScorecard(@Param("interviewId", ParseIntPipe) interviewId: number, @CurrentUser() u: CurrentUserContext) {
    return this.results.getScorecard(u.orgId, u.userId, interviewId);
  }

  @Post(":interviewId/scorecard")
  @RequirePermission("hr:interviews:manage")
  @Validate({ params: interviewIdParams })
  submitScorecard(
    @Param("interviewId", ParseIntPipe) interviewId: number,
    @Body(new ZodValidationPipe(submitScorecardSchema)) body: SubmitScorecardInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.results.submitScorecard(u.orgId, u.userId, interviewId, body);
  }
}
