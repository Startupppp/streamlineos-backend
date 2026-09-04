import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { Public } from "../../../../common/auth/public.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { NoTenantTransaction } from "../../../../common/tenant/no-tenant-transaction.decorator";
import { KbRagService } from "../services/kb-rag.service";
import { kbAskSchema, type KbAskInput } from "../dto/request.schemas";
import { Validate } from "../../../../common/validation/validate.decorator";
import {
  createStreamAbortSignal,
  encodeStreamSources,
  sourcesTruncatedHeaderName,
  pipeAiTextStream,
  rethrowStreamRouteError,
} from "../streaming";
import { AiRequestAbortInterceptor } from "../streaming";

export const KB_STREAM_DEADLINE_MS = 60_000;
const KB_SOURCES_HEADER = "x-kb-sources";

@Public()
@Controller("public/kb")
@NoTenantTransaction()
@UseInterceptors(AiRequestAbortInterceptor)
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
  async streamAsk(
    @Req() req: Request,
    @Body() body: KbAskInput,
    @Res() res: Response,
  ): Promise<void> {
    if (!this.kbRag.isEmbeddingConfigured()) {
      throw new ServiceUnavailableException("AI assistant is not available");
    }

    const abort = createStreamAbortSignal(req, res, KB_STREAM_DEADLINE_MS);

    try {
      const result = await this.kbRag.streamAnswer(
        { orgId: body.org, question: body.question },
        abort.signal,
      );

      if (!result.hasContext) {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(result.answer);
        return;
      }

      const encodedSources = encodeStreamSources(result.sources, {
        feature: "kb.public-ask",
        orgId: body.org,
      });
      const truncatedHeader = sourcesTruncatedHeaderName(KB_SOURCES_HEADER);
      await pipeAiTextStream(res, result.stream, {
        feature: "kb.public-ask",
        orgId: body.org,
        ...(encodedSources !== null
          ? {
              headers: {
                [KB_SOURCES_HEADER]: encodedSources.encoded,
                ...(encodedSources.dropped > 0
                  ? { [truncatedHeader]: String(encodedSources.dropped) }
                  : {}),
                "access-control-expose-headers":
                  encodedSources.dropped > 0
                    ? `${KB_SOURCES_HEADER}, ${truncatedHeader}`
                    : KB_SOURCES_HEADER,
              },
            }
          : {}),
      });
    } catch (error) {
      rethrowStreamRouteError(error, { route: "POST /public/kb/stream-ask" });
    } finally {
      abort.dispose();
    }
  }
}
