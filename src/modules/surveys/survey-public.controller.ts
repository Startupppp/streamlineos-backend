import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, NotFoundException, Param, Patch, Post, Request } from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { SurveyResponseService } from "./survey-response.service";
import { SurveyLiveSessionService } from "./survey-live-session.service";
import { SurveyLiveParticipantService } from "./survey-live-participant.service";
import {
  startSessionSchema,
  patchSessionSchema,
  submitSessionSchema,
  type StartSessionInput,
  type PatchSessionInput,
  type SubmitSessionInput,
} from "./dto/survey-public.schemas";
import {
  joinLiveSessionSchema,
  submitLiveAnswerSchema,
  type JoinLiveSessionInput,
  type SubmitLiveAnswerInput,
} from "./dto/survey-live-session.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const collectorTokenParams = z.object({ collectorToken: z.string().min(1) }).strict();
const collectorTokensessionIdParams = z.object({ collectorToken: z.string().min(1), sessionId: z.string().min(1) }).strict();
const sessionCodeParams = z.object({ sessionCode: z.string().min(1) }).strict();

@Controller("public/surveys")
export class SurveyPublicController {
  constructor(
    private readonly responses: SurveyResponseService,
    private readonly rateLimit: RateLimitService,
    private readonly liveSessions: SurveyLiveSessionService,
    private readonly liveParticipants: SurveyLiveParticipantService,
  ) {}

  private getIp(req: { ip?: string; headers: Record<string, string> }): string {
    return req.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ?? req.ip ?? "unknown";
  }

  private async enforceRateLimit(tier: string, identifier: string): Promise<void> {
    const result = await this.rateLimit.check(tier, identifier);
    if (!result.allowed) {
      throw new HttpException(
        { code: "SURVEY_RATE_LIMITED", message: "Too many requests. Try again later.", details: { retryAfterSeconds: result.retryAfterSecs } },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  @Public()
  @Get(":collectorToken")
  @Validate({ params: collectorTokenParams })
  async getSurvey(
    @Param("collectorToken") collectorToken: string,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("survey:public-view", this.getIp(req));
    return this.responses.getPublicSurvey(collectorToken);
  }

  @Public()
  @Post(":collectorToken/start")
  @HttpCode(201)
  @Validate({ params: collectorTokenParams, body: startSessionSchema })
  async start(
    @Param("collectorToken") collectorToken: string,
    @Body() body: StartSessionInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("survey:public-start", this.getIp(req));
    return this.responses.startSession(collectorToken, body);
  }

  @Public()
  @Patch(":collectorToken/session/:sessionId")
  @Validate({ params: collectorTokensessionIdParams })
  async saveAnswers(
    @Param("sessionId") sessionId: string,
    @Body(new ZodValidationPipe(patchSessionSchema)) body: PatchSessionInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("survey:public-submit", this.getIp(req));
    return this.responses.saveAnswers(Number(sessionId), body.answers);
  }

  @Public()
  @Post(":collectorToken/session/:sessionId/submit")
  @Validate({ params: collectorTokensessionIdParams })
  async submit(
    @Param("sessionId") sessionId: string,
    @Body(new ZodValidationPipe(submitSessionSchema)) body: SubmitSessionInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("survey:public-submit", this.getIp(req));
    return this.responses.submit(Number(sessionId), body.answers);
  }

  @Public()
  @Get("live/:sessionCode")
  @Validate({ params: sessionCodeParams })
  async getLiveSession(@Param("sessionCode") sessionCode: string) {
    return this.liveSessions.withLiveSession(sessionCode, async (session) => {
      if (session.status === "ended") throw new NotFoundException("This live session has ended");
      const question = await this.liveSessions.getCurrentQuestion(session);
      const currentQuestion = question && {
        ...question,
        choices: question.choices.map(({ isCorrect: _, ...choice }) => choice),
      };
      return { ...session, currentQuestion };
    });
  }

  @Public()
  @Post("live/:sessionCode/join")
  @HttpCode(201)
  @Validate({ params: sessionCodeParams })
  async joinLiveSession(
    @Param("sessionCode") sessionCode: string,
    @Body(new ZodValidationPipe(joinLiveSessionSchema)) body: JoinLiveSessionInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("survey:public-start", this.getIp(req));
    return this.liveSessions.withLiveSession(sessionCode, (session) => this.liveParticipants.join(session, body));
  }

  @Public()
  @Post("live/:sessionCode/answer")
  @Validate({ params: sessionCodeParams })
  async submitLiveAnswer(
    @Param("sessionCode") sessionCode: string,
    @Body(new ZodValidationPipe(submitLiveAnswerSchema)) body: SubmitLiveAnswerInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("survey:public-submit", this.getIp(req));
    return this.liveSessions.withLiveSession(sessionCode, (session) => this.liveParticipants.submitAnswer(session, body));
  }
}
