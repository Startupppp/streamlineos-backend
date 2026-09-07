import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  surveyLiveSessionRowSchema,
  liveSessionResultsSchema,
} from "./dto/survey-live-response.schemas";
import { SurveyLiveSessionService } from "./survey-live-session.service";
import { SurveyLiveParticipantService } from "./survey-live-participant.service";
import { createLiveSessionSchema, type CreateLiveSessionInput } from "./dto/survey-live-session.schemas";

const surveyIdParams = z.object({ surveyId: z.coerce.number().int().positive() }).strict();
const sessionIdParams = z.object({ sessionId: z.coerce.number().int().positive() }).strict();

@RequireModule("surveys")
@Controller("surveys")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SurveyLiveSessionController {
  constructor(
    private readonly liveSessions: SurveyLiveSessionService,
    private readonly liveParticipants: SurveyLiveParticipantService,
  ) {}

  @Post(":surveyId/live-sessions")
  @HttpCode(201)
  @RequirePermission("surveys:live:host")
  @Validate({ params: surveyIdParams, body: createLiveSessionSchema })
  @ResponseSchema(surveyLiveSessionRowSchema)
  create(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body() body: CreateLiveSessionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.liveSessions.create(u.orgId, surveyId, u.userId, body);
  }

  @Get("live-sessions/:sessionId")
  @RequirePermission("surveys:live:host")
  @Validate({ params: sessionIdParams })
  @ResponseSchema(surveyLiveSessionRowSchema)
  get(@Param("sessionId", ParseIntPipe) sessionId: number, @CurrentUser() u: CurrentUserContext) {
    return this.liveSessions.get(u.orgId, sessionId);
  }

  @Post("live-sessions/:sessionId/start")
  @BodylessAction()
  @RequirePermission("surveys:live:host")
  @Validate({ params: sessionIdParams })
  @ResponseSchema(surveyLiveSessionRowSchema)
  start(@Param("sessionId", ParseIntPipe) sessionId: number, @CurrentUser() u: CurrentUserContext) {
    return this.liveSessions.start(u.orgId, sessionId);
  }

  @Post("live-sessions/:sessionId/next")
  @BodylessAction()
  @RequirePermission("surveys:live:host")
  @Validate({ params: sessionIdParams })
  @ResponseSchema(surveyLiveSessionRowSchema)
  next(@Param("sessionId", ParseIntPipe) sessionId: number, @CurrentUser() u: CurrentUserContext) {
    return this.liveSessions.next(u.orgId, sessionId);
  }

  @Post("live-sessions/:sessionId/reveal")
  @BodylessAction()
  @RequirePermission("surveys:live:host")
  @Validate({ params: sessionIdParams })
  @ResponseSchema(surveyLiveSessionRowSchema)
  reveal(@Param("sessionId", ParseIntPipe) sessionId: number, @CurrentUser() u: CurrentUserContext) {
    return this.liveSessions.reveal(u.orgId, sessionId);
  }

  @Post("live-sessions/:sessionId/end")
  @BodylessAction()
  @RequirePermission("surveys:live:host")
  @Validate({ params: sessionIdParams })
  @ResponseSchema(surveyLiveSessionRowSchema)
  end(@Param("sessionId", ParseIntPipe) sessionId: number, @CurrentUser() u: CurrentUserContext) {
    return this.liveSessions.end(u.orgId, sessionId);
  }

  @Get("live-sessions/:sessionId/results")
  @RequirePermission("surveys:live:host")
  @Validate({ params: sessionIdParams })
  @ResponseSchema(liveSessionResultsSchema)
  async results(@Param("sessionId", ParseIntPipe) sessionId: number, @CurrentUser() u: CurrentUserContext) {
    const session = await this.liveSessions.get(u.orgId, sessionId);
    const participantCount = await this.liveParticipants.getParticipantCount(u.orgId, sessionId);
    if (!session.currentQuestionId) {
      return { participantCount, revealed: false, question: null };
    }
    const results = await this.liveParticipants.getQuestionResults(u.orgId, sessionId, session.currentQuestionId);
    return { participantCount, revealed: session.settings?.["revealed"] === true, question: results };
  }
}
