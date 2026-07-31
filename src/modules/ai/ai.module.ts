import { Module } from "@nestjs/common";
import { AiModule } from "./core/ai.module";
import { AiConfirmationModule } from "./confirmation";
import { AiJobsModule } from "./jobs/ai-jobs.module";
import { AiSummariesModule } from "./summaries/ai-summaries.module";

const AI_MODULES = [AiModule, AiConfirmationModule, AiJobsModule, AiSummariesModule];

@Module({
  imports: AI_MODULES,
  exports: AI_MODULES,
})
export class AiRootModule {}
