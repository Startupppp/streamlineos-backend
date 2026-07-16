import { Module } from "@nestjs/common";
import { ExecutiveBriefController } from "./executive-brief.controller";
import { ExecutiveBriefService } from "./executive-brief.service";
import { AiSummariesModule } from "../../ai-summaries/ai-summaries.module";
import { ProjectsModule } from "../../projects/projects.module";
import { CrmModule } from "../../crm/crm.module";
import { SupportModule } from "../../support/support.module";

@Module({
  imports: [AiSummariesModule, ProjectsModule, CrmModule, SupportModule],
  controllers: [ExecutiveBriefController],
  providers: [ExecutiveBriefService],
})
export class ExecutiveBriefModule {}
