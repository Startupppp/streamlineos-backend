import { Module } from "@nestjs/common";
import { DrizzleModule } from "../../../db/drizzle.module";
import { CrmAutomationStudioModule } from "../automation-studio/crm-automation-studio.module";
import { CrmInboxController } from "./crm-inbox.controller";
import { CrmInboxService } from "./crm-inbox.service";
import { CrmInboxAiActionsService } from "./crm-inbox-ai-actions.service";
import { CrmInboxQueriesService } from "./crm-inbox-queries.service";

@Module({
  imports: [DrizzleModule, CrmAutomationStudioModule],
  controllers: [CrmInboxController],
  providers: [CrmInboxService, CrmInboxAiActionsService, CrmInboxQueriesService],
})
export class CrmInboxModule {}
