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
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
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

@Controller("me/recruitment")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission("self:recruitment")
export class EmployeeRecruitmentController {
  constructor(
    private readonly interviews: HrInterviewsService,
    private readonly results: HrInterviewResultsService,
  ) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(selfInterviewListSchema))
    query: SelfInterviewListInput,
    @CurrentUser() user: CurrentUserContext,
  ): Promise<AssignedInterviewsPage> {
    return this.interviews.listMine(user.orgId, user.userId, query);
  }

  @Post(":interviewId/scorecard")
  @HttpCode(201)
  async submitScorecard(
    @Param("interviewId", ParseIntPipe) interviewId: number,
    @Body(new ZodValidationPipe(submitScorecardSchema))
    body: SubmitScorecardInput,
    @CurrentUser() user: CurrentUserContext,
  ): Promise<unknown> {
    const assigned = await this.interviews.isAssignedTo(
      user.orgId,
      user.userId,
      interviewId,
    );
    if (!assigned) {
      throw new ForbiddenException("This interview is not assigned to you.");
    }
    return this.results.submitScorecard(
      user.orgId,
      user.userId,
      interviewId,
      body,
    );
  }
}
