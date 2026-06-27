import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { hasRoleOrPrivileged } from "../../common/auth/role-access";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrInterviewSchedulingService } from "./hr-interview-scheduling.service";
import { HrInterviewResultsService } from "./hr-interview-results.service";
import { RECRUITMENT_ADMIN_ROLES } from "./recruitment-roles";
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

@Controller("hr/recruitment/interviews")
@UseGuards(JwtAuthGuard)
export class HrInterviewSchedulingController {
  constructor(
    private readonly scheduling: HrInterviewSchedulingService,
    private readonly results: HrInterviewResultsService,
  ) {}

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createInterviewSchema)) body: CreateInterviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.scheduling.createInterview(u.orgId, body);
  }

  @Post("schedule")
  @HttpCode(201)
  schedule(
    @Body(new ZodValidationPipe(scheduleInterviewSchema)) body: ScheduleInterviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!hasRoleOrPrivileged(u, RECRUITMENT_ADMIN_ROLES)) throw new ForbiddenException("Forbidden");
    return this.scheduling.scheduleInterview(u.orgId, u.userId, body);
  }

  @Post("self-schedule")
  @HttpCode(201)
  selfSchedule(
    @Body(new ZodValidationPipe(selfScheduleSchema)) body: SelfScheduleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!hasRoleOrPrivileged(u, RECRUITMENT_ADMIN_ROLES)) throw new ForbiddenException("Forbidden");
    return this.scheduling.selfSchedule(u.orgId, u.userId, body);
  }

  @Patch(":interviewId")
  update(
    @Param("interviewId", ParseIntPipe) interviewId: number,
    @Body(new ZodValidationPipe(updateInterviewSchema)) body: UpdateInterviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.results.updateInterview(u.orgId, interviewId, body);
  }

  @Post(":interviewId/scorecard")
  submitScorecard(
    @Param("interviewId", ParseIntPipe) interviewId: number,
    @Body(new ZodValidationPipe(submitScorecardSchema)) body: SubmitScorecardInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.results.submitScorecard(u.orgId, u.userId, interviewId, body);
  }
}
