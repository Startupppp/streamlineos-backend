import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { EmailModule } from "../email/email.module";
import { OutboxModule } from "../../common/outbox/outbox.module";
import { AccessModule } from "../access/access.module";
import { AutomationModule } from "../automation/automation.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { BillingModule } from "../billing/core/billing.module";
import { AiModule } from "../ai/core/ai.module";
import { SignAuditService } from "./sign-audit.service";
import { SignAiService } from "./sign-ai.service";
import { SignAiController } from "./sign-ai.controller";
import { SignIntegrationsService } from "./sign-integrations.service";
import { SignTokensService } from "./sign-tokens.service";
import { SignPdfService } from "./sign-pdf.service";
import { SignSettingsService } from "./sign-settings.service";
import { SignAuthMethodPolicy } from "./sign-auth-method.policy";
import { SignNotificationsService } from "./sign-notifications.service";
import { SignDocumentsService } from "./sign-documents.service";
import { SignDocumentsController } from "./sign-documents.controller";
import { SignRecipientsService } from "./sign-recipients.service";
import { SignRecipientsController } from "./sign-recipients.controller";
import { SignFieldsService } from "./sign-fields.service";
import { SignFieldsController } from "./sign-fields.controller";
import { SignEnvelopesService } from "./sign-envelopes.service";
import { SignEnvelopeAccessService } from "./sign-envelope-access.service";
import { SignEnvelopeValidationService } from "./sign-envelope-validation.service";
import { SignEnvelopeDispatchService } from "./sign-envelope-dispatch.service";
import { SignEnvelopeInvitationsService } from "./sign-envelope-invitations.service";
import { SignEnvelopeSweepsService } from "./sign-envelope-sweeps.service";
import { SignEnvelopeLifecycleService } from "./sign-envelope-lifecycle.service";
import { SMS_SENDER } from "./sms/sms-sender.port";
import { EnvSmsSender } from "./sms/env-sms-sender";
import { SIGN_GEO_IP } from "./geo/geo-ip.port";
import { AddressGeoIp } from "./geo/address-geo-ip";
import { SignBulkSendConsumer } from "./sign-bulk-send.consumer";
import { SignEnvelopesController } from "./sign-envelopes.controller";
import { SignFinalizationService } from "./sign-finalization.service";
import { SignPublicService } from "./sign-public.service";
import { SignPublicController } from "./sign-public.controller";
import { SignCertificatesController } from "./sign-certificates.controller";
import { SignTemplatesService } from "./sign-templates.service";
import { SignTemplatesController } from "./sign-templates.controller";
import { SignBulkSendService } from "./sign-bulk-send.service";
import { SignBulkSendController } from "./sign-bulk-send.controller";
import { SignWatermarkService } from "./sign-watermark.service";
import { SignAdminController } from "./sign-admin.controller";
import { SignReportsService } from "./sign-reports.service";
import { SignReportsController } from "./sign-reports.controller";
import { SignEnvelopeCompletedConsumerService } from "./sign-envelope-completed-consumer.service";

@Module({
  imports: [
    StorageModule,
    EmailModule,
    AccessModule,
    AutomationModule,
    WebhooksModule,
    NotificationsModule,
    BillingModule,
    AiModule,
    /** For OutboxConsumerRegistry: bulk send is queued rather than run inline. */
    OutboxModule,
  ],
  controllers: [
    SignDocumentsController,
    SignRecipientsController,
    SignFieldsController,
    SignEnvelopesController,
    SignPublicController,
    SignCertificatesController,
    SignTemplatesController,
    SignBulkSendController,
    SignAdminController,
    SignReportsController,
    SignAiController,
  ],
  providers: [
    SignAuthMethodPolicy,
    SignAuditService,
    SignAiService,
    SignIntegrationsService,
    SignTokensService,
    SignPdfService,
    SignSettingsService,
    SignNotificationsService,
    SignDocumentsService,
    SignRecipientsService,
    SignFieldsService,
    SignEnvelopesService,
    SignEnvelopeAccessService,
    SignEnvelopeValidationService,
    SignEnvelopeInvitationsService,
    SignEnvelopeDispatchService,
    SignEnvelopeSweepsService,
    SignEnvelopeLifecycleService,
    SignFinalizationService,
    SignTemplatesService,
    SignPublicService,
    SignBulkSendService,
    SignWatermarkService,
    SignReportsService,
    SignEnvelopeCompletedConsumerService,
    SignBulkSendConsumer,
    /**
     * SMS, behind a port. The shipped sender reports that nothing is
     * configured, which is the truth in every environment this repository
     * knows about; binding a provider is the whole change.
     */
    { provide: SMS_SENDER, useClass: EnvSmsSender },
    /**
     * Geolocation, behind a port. The shipped resolver uses no network and
     * says so in every row it writes; binding a real provider is the change.
     */
    { provide: SIGN_GEO_IP, useClass: AddressGeoIp },
  ],
  exports: [
    SignAuditService,
    SignSettingsService,
    SignEnvelopesService,
    SignTemplatesService,
    /** For the platform cron controller, which drives the sweeps across orgs. */
    SignEnvelopeSweepsService,
  ],
})
export class ESignModule {}
