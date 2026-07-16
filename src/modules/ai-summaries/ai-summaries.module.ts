import { Module } from "@nestjs/common";
import { AiSummariesController } from "./ai-summaries.controller";
import { AiSummariesService } from "./ai-summaries.service";

@Module({
  controllers: [AiSummariesController],
  providers: [AiSummariesService],
})
export class AiSummariesModule {}
