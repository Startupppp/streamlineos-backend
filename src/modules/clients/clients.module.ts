import { Module } from "@nestjs/common";
import { ClientsController } from "./clients.controller";
import { ClientAccountsService } from "./client-accounts.service";
import { ClientsEmailService } from "./clients-email.service";
import { ClientsService } from "./clients.service";
import { ClientTimelineService } from "./client-timeline.service";
import { ClientOpportunitiesService } from "./client-opportunities.service";
import { ClientOnboardingService } from "./client-onboarding.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { BillingModule } from "../billing/core/billing.module";

@Module({
  imports: [NotificationsModule, BillingModule],
  controllers: [ClientsController],
  providers: [
    ClientAccountsService,
    ClientsEmailService,
    ClientsService,
    ClientTimelineService,
    ClientOpportunitiesService,
    ClientOnboardingService,
  ],
})
export class ClientsModule {}
