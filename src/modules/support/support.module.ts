import { Module } from "@nestjs/common";
import { KbModule } from "../kb/kb.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { SupportKbController } from "./support-kb.controller";
import { SupportMacrosController } from "./support-macros.controller";
import { SupportWorkspaceController } from "./support-workspace.controller";
import { SupportRealtimeController } from "./support-realtime.controller";
import { SupportSlaController } from "./support-sla.controller";
import { SupportTicketsController } from "./support-tickets.controller";
import { SupportKbService } from "./support-kb.service";
import { SupportMacrosService } from "./support-macros.service";
import { SupportWorkspaceService } from "./support-workspace.service";
import { SupportRealtimeService } from "./support-realtime.service";
import { SupportSlaService } from "./support-sla.service";
import { SupportTicketsService } from "./support-tickets.service";
import { SupportNotificationsService } from "./support-notifications.service";

@Module({
  imports: [KbModule, RealtimeModule],
  controllers: [
    SupportKbController,
    SupportMacrosController,
    SupportWorkspaceController,
    SupportRealtimeController,
    SupportSlaController,
    SupportTicketsController,
  ],
  providers: [
    SupportKbService,
    SupportMacrosService,
    SupportWorkspaceService,
    SupportRealtimeService,
    SupportSlaService,
    SupportTicketsService,
    SupportNotificationsService,
  ],
})
export class SupportModule {}
