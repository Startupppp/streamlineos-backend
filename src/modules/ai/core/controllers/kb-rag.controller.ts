import { Body, Controller, HttpCode, Post, ServiceUnavailableException, BadRequestException, UseGuards } from "@nestjs/common";
import { Public } from "../../../../common/auth/public.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { NoTenantTransaction } from "../../../../common/tenant/no-tenant-transaction.decorator";
import { KbRagService } from "../services/kb-rag.service";
import { kbAskSchema } from "../dto/request.schemas";

@Public()
@Controller("public/kb")
@NoTenantTransaction()
export class KbRagController {
  constructor(private readonly kbRag: KbRagService) {}

  @Post("ask")
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:public-kb-ask")
  ask(@Body() body: unknown) {
    if (!this.kbRag.isEmbeddingConfigured()) {
      throw new ServiceUnavailableException("AI assistant is not available");
    }
    const parsed = kbAskSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request");

    return this.kbRag.answerQuestion({
      orgId: parsed.data.org,
      question: parsed.data.question,
    });
  }
}
