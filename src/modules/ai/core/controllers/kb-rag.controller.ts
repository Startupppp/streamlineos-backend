import {
  Body,
  Controller,
  HttpCode,
  InternalServerErrorException,
  Post,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../../../../common/auth/public.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { NoTenantTransaction } from "../../../../common/tenant/no-tenant-transaction.decorator";
import { KbRagService } from "../services/kb-rag.service";
import { kbAskSchema, type KbAskInput } from "../dto/request.schemas";
import { Validate } from "../../../../common/validation/validate.decorator";
import { logger } from "../../../../common/logger/logger.service";

@Public()
@Controller("public/kb")
@NoTenantTransaction()
export class KbRagController {
  constructor(private readonly kbRag: KbRagService) {}

  @Post("ask")
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:public-kb-ask")
  @Validate({ body: kbAskSchema })
  ask(@Body() body: KbAskInput) {
    if (!this.kbRag.isEmbeddingConfigured()) {
      throw new ServiceUnavailableException("AI assistant is not available");
    }
    return this.kbRag.answerQuestion({
      orgId: body.org,
      question: body.question,
    });
  }

  @Post("stream-ask")
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:public-kb-ask")
  @Validate({ body: kbAskSchema })
  async streamAsk(@Body() body: KbAskInput, @Res() res: Response): Promise<void> {
    if (!this.kbRag.isEmbeddingConfigured()) {
      throw new ServiceUnavailableException("AI assistant is not available");
    }

    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const deadline = AbortSignal.timeout(60_000);
    const signal = (() => {
      const ctrl = new AbortController();
      const abort = () => ctrl.abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      deadline.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted || deadline.aborted) ctrl.abort();
      return ctrl.signal;
    })();

    try {
      const result = await this.kbRag.streamAnswer(
        { orgId: body.org, question: body.question },
        signal,
      );
      if (!result.hasContext) {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(result.answer);
        return;
      }
      result.stream.pipeTextStreamToResponse(res);
    } catch (error) {
      logger.error("KB stream-ask route error", { error });
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
