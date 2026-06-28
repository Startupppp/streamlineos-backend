import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
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
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrInterviewSchedulingService } from "./hr-interview-scheduling.service";
import { HrInterviewResultsService } from "./hr-interview-results.service";
import { AccessService } from "../access/access.service";
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
    private readonly access: AccessService,
  ) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(createInterviewSchema)) body: CreateInterviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.scheduling.createInterview(u.orgId, body);
  }

  @Post("schedule")
  @HttpCode(201)
  async schedule(
    @Body(new ZodValidationPipe(scheduleInterviewSchema)) body: ScheduleInterviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.scheduling.scheduleInterview(u.orgId, u.userId, body);
  }

  @Post("self-schedule")
  @HttpCode(201)
  async selfSchedule(
    @Body(new ZodValidationPipe(selfScheduleSchema)) body: SelfScheduleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.scheduling.selfSchedule(u.orgId, u.userId, body);
  }

  @Patch(":interviewId")
  async update(
    @Param("interviewId", ParseIntPipe) interviewId: number,
    @Body(new ZodValidationPipe(updateInterviewSchema)) body: UpdateInterviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.results.updateInterview(u.orgId, interviewId, body);
  }

  @Delete(":interviewId")
  async remove(
    @Param("interviewId", ParseIntPipe) interviewId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.scheduling.deleteInterview(u.orgId, interviewId);
  }

  @Get(":interviewId/scorecard")
  getScorecard(
    @Param("interviewId", ParseIntPipe) interviewId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.results.getScorecard(u.orgId, u.userId, interviewId);
  }

  @Post(":interviewId/scorecard")
  async submitScorecard(
    @Param("interviewId", ParseIntPipe) interviewId: number,
    @Body(new ZodValidationPipe(submitScorecardSchema)) body: SubmitScorecardInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:employees:manage")) throw new ForbiddenException("Forbidden");
    }
    return this.results.submitScorecard(u.orgId, u.userId, interviewId, body);
  }
}
