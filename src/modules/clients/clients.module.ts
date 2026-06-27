import { Module } from "@nestjs/common";
import { ClientsController } from "./clients.controller";
import { ClientAccountsService } from "./client-accounts.service";
import { ClientsEmailService } from "./clients-email.service";
import { ClientsService } from "./clients.service";
import { ClientOpportunitiesService } from "./client-opportunities.service";
import { ClientOnboardingService } from "./client-onboarding.service";

@Module({
  controllers: [ClientsController],
  providers: [
    ClientAccountsService,
    ClientsEmailService,
    ClientsService,
    ClientOpportunitiesService,
    ClientOnboardingService,
  ],
})
export class ClientsModule {}
