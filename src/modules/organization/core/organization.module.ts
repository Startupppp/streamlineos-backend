import { Module } from "@nestjs/common";
import { BillingModule } from "../../billing/core/billing.module";
import { SessionsModule } from "../../sessions/sessions.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { IntegrationsModule } from "../../integrations/core/integrations.module";
import { OrganizationController } from "./organization.controller";
import { OrganizationService } from "./organization.service";
import { OrgProfileService } from "./org-profile.service";
import { OrgMembershipService } from "./org-membership.service";
import { OrgLifecycleService } from "./org-lifecycle.service";
import { OrgPurgeService } from "./org-purge.service";
import { OrganizationSettingsService } from "./organization-settings.service";
import { InvitationsService } from "./invitations.service";
import { InvitationCreateService } from "./invitation-create.service";
import { InvitationLifecycleService } from "./invitation-lifecycle.service";
import { InvitationsReadService } from "./invitations-read.service";
import { InvitationAcceptanceService } from "./invitation-acceptance.service";
import { AccountOrganizationIndexService } from "./account-organization-index.service";
import { OrganizationSagaService } from "./lifecycle/organization-saga.service";
import { OrganizationLegalHoldService } from "./lifecycle/organization-legal-hold.service";
import { OrganizationPlacementAdminService } from "./lifecycle/organization-placement-admin.service";
import { RealtimeModule } from "../../realtime/realtime.module";
import { OrgMembershipReadService } from "./org-membership-read.service";
import { OrgMembershipStatusService } from "./org-membership-status.service";
import { OrgMemberDepartureService } from "./org-member-departure.service";
import { IntegrationConnectionDisconnectedConsumer } from "./integration-connection-disconnected-consumer.service";

@Module({
  imports: [BillingModule, SessionsModule, NotificationsModule, RealtimeModule, OutboxModule, IntegrationsModule],
  controllers: [OrganizationController],
  providers: [
    OrgProfileService,
    OrgMembershipService,
    OrgMembershipReadService,
    OrgMembershipStatusService,
    OrgMemberDepartureService,
    OrgLifecycleService,
    OrgPurgeService,
    OrganizationService,
    OrganizationSettingsService,
    InvitationCreateService,
    InvitationLifecycleService,
    InvitationsService,
    InvitationsReadService,
    InvitationAcceptanceService,
    AccountOrganizationIndexService,
    OrganizationSagaService,
    OrganizationLegalHoldService,
    OrganizationPlacementAdminService,
    IntegrationConnectionDisconnectedConsumer,
  ],
  exports: [
    InvitationCreateService,
    InvitationLifecycleService,
    InvitationsService,
    InvitationsReadService,
    InvitationAcceptanceService,
    OrgMembershipService,
    OrgMembershipStatusService,
    OrgMemberDepartureService,
    AccountOrganizationIndexService,
    OrganizationSagaService,
  ],
})
export class OrganizationModule {}
