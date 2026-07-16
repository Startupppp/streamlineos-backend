import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AutomationController } from "./automation.controller";
import { AutomationService } from "./automation.service";
import { AutomationEmailService } from "./automation-email.service";

@Module({
  imports: [BillingModule, NotificationsModule],
  controllers: [AutomationController],
  providers: [AutomationService, AutomationEmailService],
  exports: [AutomationService, AutomationEmailService],
})
export class AutomationModule {}
