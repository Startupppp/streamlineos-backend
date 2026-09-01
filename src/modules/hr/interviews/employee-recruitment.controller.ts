import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";

import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import {
  selfInterviewListSchema,
  type SelfInterviewListInput,
} from "./dto/hr-interviews.schemas";
import {
  submitScorecardSchema,
  type SubmitScorecardInput,
} from "./dto/interview-scheduling.schemas";
import { HrInterviewResultsService } from "./hr-interview-results.service";
import {
  HrInterviewsService,
  type AssignedInterviewsPage,
} from "./hr-interviews.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { actingMembershipId } from "../../../common/auth/principal";

const interviewIdParams = z.object({ interviewId: z.coerce.number().int().positive() }).strict();

@Controller("me/recruitment")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission("self:recruitment")
export class EmployeeRecruitmentController {
  constructor(
    private readonly interviews: HrInterviewsService,
    private readonly results: HrInterviewResultsService,
  ) {}

  @Get()
  @Validate({ query: selfInterviewListSchema })
  list(
    @Query() query: SelfInterviewListInput,
    @CurrentUser() user: CurrentUserContext,
  ): Promise<AssignedInterviewsPage> {
    return this.interviews.listMine(user.orgId, actingMembershipId(user.principal), query);
  }

  @Post(":interviewId/scorecard")
  @HttpCode(201)
  @Validate({ params: interviewIdParams, body: submitScorecardSchema })
  async submitScorecard(
    @Param("interviewId", ParseIntPipe) interviewId: number,
    @Body() body: SubmitScorecardInput,
    @CurrentUser() user: CurrentUserContext,
  ): Promise<unknown> {
    const assigned = await this.interviews.isAssignedTo(
      user.orgId,
      actingMembershipId(user.principal),
      interviewId,
    );
    if (!assigned) {
      throw new ForbiddenException("This interview is not assigned to you.");
    }
    return this.results.submitScorecard(
      user.orgId,
      user.userId,
      actingMembershipId(user.principal),
      interviewId,
      body,
    );
  }
}
