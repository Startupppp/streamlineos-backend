import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { SessionsModule } from "../sessions/sessions.module";
import { OrganizationController } from "./organization.controller";
import { OrganizationService } from "./organization.service";
import { OrganizationSettingsService } from "./organization-settings.service";
import { InvitationsService } from "./invitations.service";
import { OrganizationInvitationsController } from "../email/controllers/organization-invitations.controller";

@Module({
  imports: [BillingModule, SessionsModule],
  controllers: [OrganizationController, OrganizationInvitationsController],
  providers: [OrganizationService, OrganizationSettingsService, InvitationsService],
  exports: [InvitationsService],
})
export class OrganizationModule {}
