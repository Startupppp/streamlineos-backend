import { Module } from "@nestjs/common";
import { ExecutiveBriefController } from "./executive-brief.controller";
import { ExecutiveBriefService } from "./executive-brief.service";
import { AiSummariesModule } from "../../ai-summaries/ai-summaries.module";

@Module({
  imports: [AiSummariesModule],
  controllers: [ExecutiveBriefController],
  providers: [ExecutiveBriefService],
})
export class ExecutiveBriefModule {}
