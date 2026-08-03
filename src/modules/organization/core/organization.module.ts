import { Module } from "@nestjs/common";
import { BillingModule } from "../../billing/core/billing.module";
import { SessionsModule } from "../../sessions/sessions.module";
import { OrganizationController } from "./organization.controller";
import { OrganizationService } from "./organization.service";
import { OrgProfileService } from "./org-profile.service";
import { OrgMembershipService } from "./org-membership.service";
import { OrgLifecycleService } from "./org-lifecycle.service";
import { OrganizationSettingsService } from "./organization-settings.service";
import { InvitationsService } from "./invitations.service";

@Module({
  imports: [BillingModule, SessionsModule],
  controllers: [OrganizationController],
  providers: [
    OrgProfileService,
    OrgMembershipService,
    OrgLifecycleService,
    OrganizationService,
    OrganizationSettingsService,
    InvitationsService,
  ],
  exports: [InvitationsService, OrgMembershipService],
})
export class OrganizationModule {}
