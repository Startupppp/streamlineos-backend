import { Global, Module } from "@nestjs/common";
import { EmailService } from "./email.service";
import { EmailRoutesService } from "./email-routes.service";
import { TwilioGateway } from "./dispatch/twilio.gateway";
import { NotificationsDispatchController } from "./controllers/notifications-dispatch.controller";
import { OrganizationInvitationsController } from "./controllers/organization-invitations.controller";
import { EmailTemplatesController } from "./controllers/email-templates.controller";

@Global()
@Module({
  controllers: [
    NotificationsDispatchController,
    OrganizationInvitationsController,
    EmailTemplatesController,
  ],
  providers: [EmailService, EmailRoutesService, TwilioGateway],
  exports: [EmailService],
})
export class EmailModule {}
