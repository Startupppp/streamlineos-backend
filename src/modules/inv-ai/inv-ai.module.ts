import { Module } from "@nestjs/common";
import { InvAiController } from "./inv-ai.controller";
import { InvAiService } from "./inv-ai.service";
import { InvAiExplainController } from "./inv-ai-explain.controller";
import { InvAiExplainService } from "./inv-ai-explain.service";
import { AiModule } from "../ai/ai.module";

@Module({
  imports: [AiModule],
  controllers: [InvAiController, InvAiExplainController],
  providers: [InvAiService, InvAiExplainService],
  exports: [InvAiService, InvAiExplainService],
})
export class InvAiModule {}
