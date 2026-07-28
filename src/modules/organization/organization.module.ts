import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { SessionsModule } from "../sessions/sessions.module";
import { OrganizationController } from "./organization.controller";
import { OrganizationService } from "./organization.service";
import { OrgProfileService } from "./org-profile.service";
import { OrgMembershipService } from "./org-membership.service";
import { OrgLifecycleService } from "./org-lifecycle.service";
import { OrgOwnershipService } from "./org-ownership.service";
import { OrganizationSettingsService } from "./organization-settings.service";
import { InvitationsService } from "./invitations.service";
import { OrganizationInvitationsController } from "../email/controllers/organization-invitations.controller";

@Module({
  imports: [BillingModule, SessionsModule],
  controllers: [OrganizationController, OrganizationInvitationsController],
  providers: [
    OrgProfileService,
    OrgMembershipService,
    OrgLifecycleService,
    OrgOwnershipService,
    OrganizationService,
    OrganizationSettingsService,
    InvitationsService,
  ],
  exports: [InvitationsService],
})
export class OrganizationModule {}
