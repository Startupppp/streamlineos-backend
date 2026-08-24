import { Global, Module } from "@nestjs/common";
import { EmailService } from "./email.service";
import { EmailProviderService } from "./email.provider";
import { EmailOutboxService } from "./email-outbox.service";
import { EmailRoutesService } from "./email-routes.service";
import { TwilioGateway } from "./dispatch/twilio.gateway";
import { NotificationsDispatchController } from "./controllers/notifications-dispatch.controller";
import { EmailTemplatesController } from "./controllers/email-templates.controller";
import { HrSendEmailController } from "./controllers/hr-send-email.controller";
import { EmailSuppressionService } from "./email-suppression.service";
import { EmailWebhookService } from "./email-webhook.service";
import { EmailWebhookController } from "./email-webhook.controller";
import { UnsubscribeController } from "./unsubscribe.controller";

@Global()
@Module({
  controllers: [
    NotificationsDispatchController,
    EmailTemplatesController,
    HrSendEmailController,
    EmailWebhookController,
    UnsubscribeController,
  ],
  providers: [
    EmailProviderService,
    EmailOutboxService,
    EmailService,
    EmailRoutesService,
    TwilioGateway,
    EmailSuppressionService,
    EmailWebhookService,
  ],
  exports: [EmailProviderService, EmailOutboxService, EmailService, EmailSuppressionService],
})
export class EmailModule {}
