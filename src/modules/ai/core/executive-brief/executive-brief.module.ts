import { Module } from "@nestjs/common";
import { ExecutiveBriefController } from "./executive-brief.controller";
import { ExecutiveBriefService } from "./executive-brief.service";
import { AiSummariesModule } from "../../summaries/ai-summaries.module";
import { AiRequestAbortInterceptor } from "../streaming";

@Module({
  imports: [AiSummariesModule],
  controllers: [ExecutiveBriefController],
  providers: [ExecutiveBriefService, AiRequestAbortInterceptor],
})
export class ExecutiveBriefModule {}
