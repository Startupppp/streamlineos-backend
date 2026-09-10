import { Module } from "@nestjs/common";
import { OrgController } from "./org.controller";
import { OrgMembersService } from "./org-members.service";
import { OrgSetupService } from "./org-setup.service";
import { OrgSetupResolverService } from "./org-setup-resolver.service";
import { AnnouncementsController } from "./announcements.controller";
import { AnnouncementsService } from "./announcements.service";
import { OnboardingFlowModule } from "../../hr/onboarding/flow/onboarding-flow.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { OrganizationModule } from "../core/organization.module";
import { WorkspaceOnboardingModule } from "../onboarding/workspace-onboarding.module";
import { OrgSetupCompletedConsumerService } from "./org-setup-completed-consumer.service";

@Module({
  imports: [
    OnboardingFlowModule,
    NotificationsModule,
    OutboxModule,
    OrganizationModule,
    WorkspaceOnboardingModule,
  ],
  controllers: [OrgController, AnnouncementsController],
  providers: [
    OrgMembersService,
    OrgSetupService,
    OrgSetupResolverService,
    AnnouncementsService,
    OrgSetupCompletedConsumerService,
  ],
})
export class OrgModule {}
