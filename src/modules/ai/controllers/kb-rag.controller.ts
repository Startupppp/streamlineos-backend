import { Body, Controller, HttpCode, Post, ServiceUnavailableException, BadRequestException } from "@nestjs/common";
import { Public } from "../../../common/auth/public.decorator";
import { KbRagService } from "../services/kb-rag.service";
import { kbAskSchema } from "../dto/request.schemas";

@Public()
@Controller("public/kb")
export class KbRagController {
  constructor(private readonly kbRag: KbRagService) {}

  @Post("ask")
  @HttpCode(200)
  ask(@Body() body: unknown) {
    if (!this.kbRag.isEmbeddingConfigured()) {
      throw new ServiceUnavailableException("AI assistant is not available");
    }
    const parsed = kbAskSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request");

    return this.kbRag.answerQuestion({
      orgId: parsed.data.org,
      question: parsed.data.question,
      publicOnly: true,
    });
  }
}
