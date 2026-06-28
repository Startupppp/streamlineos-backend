import { Module } from "@nestjs/common";
import { KbModule } from "../kb/kb.module";
import { SupportKbController } from "./support-kb.controller";
import { SupportMacrosController } from "./support-macros.controller";
import { SupportTicketsController } from "./support-tickets.controller";
import { SupportKbService } from "./support-kb.service";
import { SupportMacrosService } from "./support-macros.service";
import { SupportTicketsService } from "./support-tickets.service";
import { SupportNotificationsService } from "./support-notifications.service";

@Module({
  imports: [KbModule],
  controllers: [SupportKbController, SupportMacrosController, SupportTicketsController],
  providers: [
    SupportKbService,
    SupportMacrosService,
    SupportTicketsService,
    SupportNotificationsService,
  ],
})
export class SupportModule {}
