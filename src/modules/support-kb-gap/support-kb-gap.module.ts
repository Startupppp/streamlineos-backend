import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { AiJobsModule } from "../ai-jobs/ai-jobs.module";
import { KbModule } from "../kb/kb.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { SupportKbGapService } from "./support-kb-gap.service";
import { SupportKbGapController } from "./support-kb-gap.controller";
import { SupportKbGapJobHandler } from "./support-kb-gap-job.handler";

@Module({
  imports: [AiModule, AiJobsModule, KbModule, NotificationsModule],
  controllers: [SupportKbGapController],
  providers: [SupportKbGapService, SupportKbGapJobHandler],
  exports: [SupportKbGapService],
})
export class SupportKbGapModule {}
