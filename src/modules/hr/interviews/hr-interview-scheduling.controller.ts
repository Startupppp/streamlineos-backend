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
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  interviewSchema,
  scheduleInterviewWithPanelSchema,
  selfScheduleResponseSchema,
  successSchema,
  interviewScorecardSchema,
} from "./dto/interviews-response.schemas";
import { actingMembershipId } from "../../../common/auth/principal";
import { InterviewAvailabilityService } from "./calendar/interview-availability.service";

const interviewIdParams = z.object({ interviewId: z.coerce.number().int().positive() }).strict();

/**
 * A window a recruiter is looking at, capped at four weeks.
 *
 * The cap is not arbitrary tidiness: the busy query reads up to 500 interviews
 * and a year-long window on a busy panel would silently truncate at that limit,
 * producing slots that look free because the conflicting interview fell off the
 * end of the page.
 */
const suggestSlotsSchema = z
  .object({
    /** User ids, as every interviewer picker on the frontend lists them. */
    panelUserIds: z.array(z.string().min(1)).min(1).max(20),
    from: z.coerce.date(),
    to: z.coerce.date(),
    durationMinutes: z.coerce.number().int().min(5).max(480).default(60),
    granularityMinutes: z.coerce.number().int().min(5).max(120).default(30),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    ignoreInterviewId: z.coerce.number().int().positive().optional(),
  })
  .strict()
  .refine((body) => body.to.getTime() > body.from.getTime(), {
    message: "`to` must be after `from`.",
    path: ["to"],
  })
  .refine((body) => body.to.getTime() - body.from.getTime() <= 28 * 24 * 60 * 60 * 1000, {
    message: "Suggest over a window of four weeks or less.",
    path: ["to"],
  });
type SuggestSlotsInput = z.infer<typeof suggestSlotsSchema>;

const suggestedSlotsSchema = z.object({
  slots: z.array(z.object({ start: z.string(), end: z.string() })),
  source: z.enum(["streamline-only", "calendar"]),
  blockedReason: z.string().nullable(),
  unseenMembershipIds: z.array(z.number().int()),
});

@RequireModule("hr")
@Controller("hr/recruitment/interviews")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrInterviewSchedulingController {
  constructor(
    private readonly scheduling: HrInterviewSchedulingService,
    private readonly results: HrInterviewResultsService,
    private readonly availability: InterviewAvailabilityService,
  ) {}

  @Post()
  @HttpCode(201)
  @ResponseSchema(interviewSchema)
  @RequirePermission("hr:interviews:manage")
  @Validate({ body: createInterviewSchema })
  create(@Body() body: CreateInterviewInput, @CurrentUser() u: CurrentUserContext) {
    return this.scheduling.createInterview(u.orgId, body);
  }

  @Post("schedule")
  @HttpCode(201)
  @ResponseSchema(scheduleInterviewWithPanelSchema)
  @RequirePermission("hr:interviews:manage")
  @Validate({ body: scheduleInterviewSchema })
  schedule(@Body() body: ScheduleInterviewInput, @CurrentUser() u: CurrentUserContext) {
    return this.scheduling.scheduleInterview(u.orgId, u.userId, actingMembershipId(u.principal), body);
  }

  @Post("self-schedule")
  @HttpCode(201)
  @ResponseSchema(selfScheduleResponseSchema)
  @RequirePermission("hr:interviews:manage")
  @Validate({ body: selfScheduleSchema })
  selfSchedule(@Body() body: SelfScheduleInput, @CurrentUser() u: CurrentUserContext) {
    return this.scheduling.selfSchedule(u.orgId, u.userId, actingMembershipId(u.principal), body);
  }

  @Patch(":interviewId")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:interviews:manage")
  @Validate({ params: interviewIdParams, body: updateInterviewSchema })
  update(
    @Param("interviewId", ParseIntPipe) interviewId: number,
    @Body() body: UpdateInterviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.results.updateInterview(u.orgId, interviewId, body);
  }

  @Delete(":interviewId")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:interviews:manage")
  @Validate({ params: interviewIdParams })
  remove(@Param("interviewId", ParseIntPipe) interviewId: number, @CurrentUser() u: CurrentUserContext) {
    return this.scheduling.deleteInterview(u.orgId, interviewId);
  }

  @Get(":interviewId/scorecard")
  @ResponseSchema(interviewScorecardSchema.nullable())
  @RequirePermission("hr:interviews:view")
  @Validate({ params: interviewIdParams })
  getScorecard(@Param("interviewId", ParseIntPipe) interviewId: number, @CurrentUser() u: CurrentUserContext) {
    return this.results.getScorecard(u.orgId, u.userId, actingMembershipId(u.principal), interviewId);
  }

  @Post(":interviewId/scorecard")
  @ResponseSchema(interviewScorecardSchema)
  @RequirePermission("hr:interviews:manage")
  @Validate({ params: interviewIdParams, body: submitScorecardSchema })
  submitScorecard(
    @Param("interviewId", ParseIntPipe) interviewId: number,
    @Body() body: SubmitScorecardInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.results.submitScorecard(u.orgId, u.userId, actingMembershipId(u.principal), interviewId, body);
  }

  /**
   * Times the whole panel is free, for a recruiter building a booking link.
   *
   * A POST rather than a GET because the panel is a list and a list in a query
   * string is a parsing convention nobody agrees on. It writes nothing, and
   * `hr:interviews:manage` matches what the caller is about to do with the
   * answer.
   *
   * The response says where the busy picture came from. With no calendar
   * connected these slots avoid interviews already in StreamlineOS and nothing
   * else, and a screen that showed them as simply "free" would be promising
   * more than the data supports.
   */
  @Post("suggest-slots")
  @HttpCode(200)
  @ResponseSchema(suggestedSlotsSchema)
  @RequirePermission("hr:interviews:manage")
  @Validate({ body: suggestSlotsSchema })
  async suggestSlots(@Body() body: SuggestSlotsInput, @CurrentUser() u: CurrentUserContext) {
    const panelMembershipIds = await this.availability.membershipIdsForUsers(
      u.orgId,
      body.panelUserIds,
    );
    return this.availability.suggest({
      orgId: u.orgId,
      panelMembershipIds,
      window: { start: body.from, end: body.to },
      durationMinutes: body.durationMinutes,
      granularityMinutes: body.granularityMinutes,
      limit: body.limit,
      ignoreInterviewId: body.ignoreInterviewId,
    });
  }
}
