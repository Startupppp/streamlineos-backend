import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { AutomationController } from "./automation.controller";
import { AutomationService } from "./automation.service";
import { AutomationEmailService } from "./automation-email.service";

@Module({
  imports: [NotificationsModule],
  controllers: [AutomationController],
  providers: [AutomationService, AutomationEmailService],
  exports: [AutomationService, AutomationEmailService],
})
export class AutomationModule {}
