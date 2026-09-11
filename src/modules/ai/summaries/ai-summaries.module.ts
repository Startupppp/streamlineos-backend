import { Module } from "@nestjs/common";
import { AiSummariesController } from "./ai-summaries.controller";
import { AiSummariesService } from "./ai-summaries.service";
import { AiRequestAbortInterceptor } from "../core/streaming";

@Module({
  controllers: [AiSummariesController],
  providers: [AiSummariesService, AiRequestAbortInterceptor],
  exports: [AiSummariesService],
})
export class AiSummariesModule {}
