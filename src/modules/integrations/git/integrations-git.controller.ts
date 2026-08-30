import {
  Controller,
  Headers,
  HttpCode,
  Post,
  Query,
  RawBodyRequest,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../../../common/auth/public.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { logger } from "../../../common/logger/logger.service";
import { IntegrationsGitService } from "./integrations-git.service";
import { webhookQuerySchema } from "./dto/integrations-git.schemas";

@Public()
@Controller("integrations/git")
export class IntegrationsGitController {
  constructor(private readonly integrationsGit: IntegrationsGitService) {}

  @Post("webhook")
  @HttpCode(200)
  @Validate({ query: webhookQuerySchema })
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Query("connectionId") connectionId: string | undefined,
    @Headers("x-hub-signature-256") signature256: string | undefined,
    @Headers("x-gitlab-token") gitlabToken: string | undefined,
    @Headers("x-github-event") githubEvent: string | undefined,
    @Headers("x-gitlab-event") gitlabEvent: string | undefined,
  ): Promise<{ ok: true }> {
    const ack: { ok: true } = { ok: true };
    try {
      await this.integrationsGit.processWebhook({
        connectionIdRaw: connectionId,
        rawBody: req.rawBody?.toString("utf8") ?? "",
        signature256,
        gitlabToken,
        githubEvent,
        gitlabEvent,
      });
      return ack;
    } catch (error) {
      logger.error("[git-webhook] unexpected error", { error });
      return ack;
    }
  }
}
