import { Module } from "@nestjs/common";
import { OrganizationController } from "./organization.controller";
import { OrganizationService } from "./organization.service";
import { OrganizationSettingsService } from "./organization-settings.service";
import { InvitationsService } from "./invitations.service";
import { OrganizationInvitationsController } from "../email/controllers/organization-invitations.controller";

@Module({
  controllers: [OrganizationController, OrganizationInvitationsController],
  providers: [OrganizationService, OrganizationSettingsService, InvitationsService],
  exports: [InvitationsService],
})
export class OrganizationModule {}
