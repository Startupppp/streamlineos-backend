import { Body, Controller, HttpCode, Post, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import { Public } from "../../../../common/auth/public.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { NoTenantTransaction } from "../../../../common/tenant/no-tenant-transaction.decorator";
import { KbRagService } from "../services/kb-rag.service";
import { kbAskSchema, type KbAskInput } from "../dto/request.schemas";
import { Validate } from "../../../../common/validation/validate.decorator";

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
}
