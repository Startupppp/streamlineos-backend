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
import { InvitationAcceptanceService } from "./invitation-acceptance.service";
import { AccountOrganizationIndexService } from "./account-organization-index.service";
import { OrganizationSagaService } from "./lifecycle/organization-saga.service";
import { OrganizationLegalHoldService } from "./lifecycle/organization-legal-hold.service";
import { OrganizationPlacementAdminService } from "./lifecycle/organization-placement-admin.service";
import { RealtimeModule } from "../../realtime/realtime.module";
import { OrgMembershipReadService } from "./org-membership-read.service";

@Module({
  imports: [BillingModule, SessionsModule, NotificationsModule, RealtimeModule],
  controllers: [OrganizationController],
  providers: [
    OrgProfileService,
    OrgMembershipService,
    OrgMembershipReadService,
    OrgLifecycleService,
    OrganizationService,
    OrganizationSettingsService,
    InvitationsService,
    InvitationsReadService,
    InvitationAcceptanceService,
    AccountOrganizationIndexService,
    OrganizationSagaService,
    OrganizationLegalHoldService,
    OrganizationPlacementAdminService,
  ],
  exports: [
    InvitationsService,
    InvitationsReadService,
    InvitationAcceptanceService,
    OrgMembershipService,
    AccountOrganizationIndexService,
    OrganizationSagaService,
  ],
})
export class OrganizationModule {}
