import { Module } from "@nestjs/common";
import { KbModule } from "../kb/kb.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { AutomationModule } from "../automation/automation.module";
import { AiModule } from "../ai/ai.module";
import { SupportKbController } from "./support-kb.controller";
import { SupportMacrosController } from "./support-macros.controller";
import { SupportWorkspaceController } from "./support-workspace.controller";
import { SupportRealtimeController } from "./support-realtime.controller";
import { SupportSlaController } from "./support-sla.controller";
import { SupportPortalController } from "./support-portal.controller";
import { SupportChannelsController } from "./support-channels.controller";
import { SupportAutomationsController } from "./support-automations.controller";
import { SupportCsatController } from "./support-csat.controller";
import { SupportAiController } from "./support-ai.controller";
import { SupportReportsController } from "./support-reports.controller";
import { SupportTicketsController } from "./support-tickets.controller";
import { SupportKbService } from "./support-kb.service";
import { SupportMacrosService } from "./support-macros.service";
import { SupportWorkspaceService } from "./support-workspace.service";
import { SupportRealtimeService } from "./support-realtime.service";
import { SupportSlaService } from "./support-sla.service";
import { SupportPortalService } from "./support-portal.service";
import { SupportChannelsService } from "./support-channels.service";
import { SupportCsatService } from "./support-csat.service";
import { SupportAiService } from "./support-ai.service";
import { SupportReportsService } from "./support-reports.service";
import { SupportTicketsService } from "./support-tickets.service";
import { SupportNotificationsService } from "./support-notifications.service";

@Module({
  imports: [KbModule, RealtimeModule, AutomationModule, AiModule],
  controllers: [
    SupportKbController,
    SupportMacrosController,
    SupportWorkspaceController,
    SupportRealtimeController,
    SupportSlaController,
    SupportChannelsController,
    SupportAutomationsController,
    SupportCsatController,
    SupportAiController,
    SupportReportsController,
    SupportPortalController,
    SupportTicketsController,
  ],
  providers: [
    SupportKbService,
    SupportMacrosService,
    SupportWorkspaceService,
    SupportRealtimeService,
    SupportSlaService,
    SupportPortalService,
    SupportChannelsService,
    SupportCsatService,
    SupportAiService,
    SupportReportsService,
    SupportTicketsService,
    SupportNotificationsService,
  ],
  exports: [SupportSlaService],
})
export class SupportModule {}
