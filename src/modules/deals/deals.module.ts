import { Module } from "@nestjs/common";
import { DealsController } from "./deals.controller";
import { DealsAnalyticsController } from "./deals-analytics.controller";
import { DealsApprovalsController } from "./deals-approvals.controller";
import { DealsMeetingsController } from "./deals-meetings.controller";
import { DealsService } from "./deals.service";
import { DealsAnalyticsService } from "./deals-analytics.service";
import { DealsApprovalsService } from "./deals-approvals.service";
import { DealsMeetingsService } from "./deals-meetings.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { AutomationModule } from "../automation/automation.module";

@Module({
  imports: [NotificationsModule, AutomationModule],
  controllers: [
    DealsAnalyticsController,
    DealsApprovalsController,
    DealsMeetingsController,
    DealsController,
  ],
  providers: [
    DealsService,
    DealsAnalyticsService,
    DealsApprovalsService,
    DealsMeetingsService,
  ],
})
export class DealsModule {}
