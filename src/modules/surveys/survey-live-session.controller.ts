import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SurveyLiveSessionService } from "./survey-live-session.service";
import { SurveyLiveParticipantService } from "./survey-live-participant.service";
import { createLiveSessionSchema, type CreateLiveSessionInput } from "./dto/survey-live-session.schemas";

const surveyIdParams = z.object({ surveyId: z.coerce.number().int().positive() }).strict();
const sessionIdParams = z.object({ sessionId: z.coerce.number().int().positive() }).strict();

@Controller("surveys")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SurveyLiveSessionController {
  constructor(
    private readonly liveSessions: SurveyLiveSessionService,
    private readonly liveParticipants: SurveyLiveParticipantService,
  ) {}

  @Post(":surveyId/live-sessions")
  @HttpCode(201)
  @RequirePermission("surveys:live:host")
  @Validate({ params: surveyIdParams })
  create(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body(new ZodValidationPipe(createLiveSessionSchema)) body: CreateLiveSessionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.liveSessions.create(u.orgId, surveyId, u.userId, body);
  }

  @Get("live-sessions/:sessionId")
  @RequirePermission("surveys:live:host")
  @Validate({ params: sessionIdParams })
  get(@Param("sessionId", ParseIntPipe) sessionId: number, @CurrentUser() u: CurrentUserContext) {
    return this.liveSessions.get(u.orgId, sessionId);
  }

  @Post("live-sessions/:sessionId/start")
  @RequirePermission("surveys:live:host")
  @Validate({ params: sessionIdParams })
  start(@Param("sessionId", ParseIntPipe) sessionId: number, @CurrentUser() u: CurrentUserContext) {
    return this.liveSessions.start(u.orgId, sessionId);
  }

  @Post("live-sessions/:sessionId/next")
  @RequirePermission("surveys:live:host")
  @Validate({ params: sessionIdParams })
  next(@Param("sessionId", ParseIntPipe) sessionId: number, @CurrentUser() u: CurrentUserContext) {
    return this.liveSessions.next(u.orgId, sessionId);
  }

  @Post("live-sessions/:sessionId/reveal")
  @RequirePermission("surveys:live:host")
  @Validate({ params: sessionIdParams })
  reveal(@Param("sessionId", ParseIntPipe) sessionId: number, @CurrentUser() u: CurrentUserContext) {
    return this.liveSessions.reveal(u.orgId, sessionId);
  }

  @Post("live-sessions/:sessionId/end")
  @RequirePermission("surveys:live:host")
  @Validate({ params: sessionIdParams })
  end(@Param("sessionId", ParseIntPipe) sessionId: number, @CurrentUser() u: CurrentUserContext) {
    return this.liveSessions.end(u.orgId, sessionId);
  }

  @Get("live-sessions/:sessionId/results")
  @RequirePermission("surveys:live:host")
  @Validate({ params: sessionIdParams })
  async results(@Param("sessionId", ParseIntPipe) sessionId: number, @CurrentUser() u: CurrentUserContext) {
    const session = await this.liveSessions.get(u.orgId, sessionId);
    const participantCount = await this.liveParticipants.getParticipantCount(sessionId);
    if (!session.currentQuestionId) {
      return { participantCount, revealed: false, question: null };
    }
    const results = await this.liveParticipants.getQuestionResults(sessionId, session.currentQuestionId);
    return { participantCount, revealed: Boolean((session.settings as { revealed?: boolean })?.revealed), question: results };
  }
}
