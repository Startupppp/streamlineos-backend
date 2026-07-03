import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Param, Patch, Post, Request } from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { SurveyResponseService } from "./survey-response.service";
import {
  startSessionSchema,
  patchSessionSchema,
  submitSessionSchema,
  type StartSessionInput,
  type PatchSessionInput,
  type SubmitSessionInput,
} from "./dto/survey-public.schemas";

// Live session public join/answer routes (/public/surveys/live/:sessionCode/...) land in the
// live-sessions milestone alongside the participant/answer tracking model they need.
@Controller("public/surveys")
export class SurveyPublicController {
  constructor(
    private readonly responses: SurveyResponseService,
    private readonly rateLimit: RateLimitService,
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
  async start(
    @Param("collectorToken") collectorToken: string,
    @Body(new ZodValidationPipe(startSessionSchema)) body: StartSessionInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("survey:public-start", this.getIp(req));
    return this.responses.startSession(collectorToken, body);
  }

  @Public()
  @Patch(":collectorToken/session/:sessionId")
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
  async submit(
    @Param("sessionId") sessionId: string,
    @Body(new ZodValidationPipe(submitSessionSchema)) body: SubmitSessionInput,
    @Request() req: { ip?: string; headers: Record<string, string> },
  ) {
    await this.enforceRateLimit("survey:public-submit", this.getIp(req));
    return this.responses.submit(Number(sessionId), body.answers);
  }
}
