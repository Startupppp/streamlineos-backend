import { Module } from "@nestjs/common";
import { BillingModule } from "../../billing/core/billing.module";
import { SessionsModule } from "../../sessions/sessions.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { OrganizationController } from "./organization.controller";
import { OrganizationService } from "./organization.service";
import { OrgProfileService } from "./org-profile.service";
import { OrgMembershipService } from "./org-membership.service";
import { OrgLifecycleService } from "./org-lifecycle.service";
import { OrganizationSettingsService } from "./organization-settings.service";
import { InvitationsService } from "./invitations.service";
import { InvitationsReadService } from "./invitations-read.service";
import { InvitationLifecycleService } from "./invitation-lifecycle.service";
import { InvitationAcceptanceService } from "./invitation-acceptance.service";

@Module({
  imports: [BillingModule, SessionsModule, NotificationsModule],
  controllers: [OrganizationController],
  providers: [
    OrgProfileService,
    OrgMembershipService,
    OrgLifecycleService,
    OrganizationService,
    OrganizationSettingsService,
    InvitationsService,
    InvitationsReadService,
    InvitationAcceptanceService,
    InvitationLifecycleService,
  ],
  exports: [
    InvitationsService,
    InvitationsReadService,
    InvitationAcceptanceService,
    InvitationLifecycleService,
    OrgMembershipService,
  ],
})
export class OrganizationModule {}
