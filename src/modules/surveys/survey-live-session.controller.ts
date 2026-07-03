import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SurveyLiveSessionService } from "./survey-live-session.service";
import { createLiveSessionSchema, type CreateLiveSessionInput } from "./dto/survey-live-session.schemas";

@Controller("surveys")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SurveyLiveSessionController {
  constructor(private readonly liveSessions: SurveyLiveSessionService) {}

  @Post(":surveyId/live-sessions")
  @HttpCode(201)
  @RequirePermission("surveys:live:host")
  create(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body(new ZodValidationPipe(createLiveSessionSchema)) body: CreateLiveSessionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.liveSessions.create(u.orgId, surveyId, u.userId, body);
  }

  @Get("live-sessions/:sessionId")
  @RequirePermission("surveys:live:host")
  get(@Param("sessionId", ParseIntPipe) sessionId: number) {
    return this.liveSessions.get(sessionId);
  }

  @Post("live-sessions/:sessionId/start")
  @RequirePermission("surveys:live:host")
  start(@Param("sessionId", ParseIntPipe) sessionId: number) {
    return this.liveSessions.start(sessionId);
  }

  @Post("live-sessions/:sessionId/next")
  @RequirePermission("surveys:live:host")
  next(@Param("sessionId", ParseIntPipe) sessionId: number) {
    return this.liveSessions.next(sessionId);
  }

  @Post("live-sessions/:sessionId/reveal")
  @RequirePermission("surveys:live:host")
  reveal(@Param("sessionId", ParseIntPipe) sessionId: number) {
    return this.liveSessions.reveal(sessionId);
  }

  @Post("live-sessions/:sessionId/end")
  @RequirePermission("surveys:live:host")
  end(@Param("sessionId", ParseIntPipe) sessionId: number) {
    return this.liveSessions.end(sessionId);
  }
}
