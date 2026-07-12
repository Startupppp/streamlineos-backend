import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { EmailModule } from "../email/email.module";
import { AccessModule } from "../access/access.module";
import { SignAuditService } from "./sign-audit.service";
import { SignTokensService } from "./sign-tokens.service";
import { SignPdfService } from "./sign-pdf.service";
import { SignSettingsService } from "./sign-settings.service";
import { SignNotificationsService } from "./sign-notifications.service";
import { SignDocumentsService } from "./sign-documents.service";
import { SignDocumentsController } from "./sign-documents.controller";
import { SignRecipientsService } from "./sign-recipients.service";
import { SignRecipientsController } from "./sign-recipients.controller";
import { SignFieldsService } from "./sign-fields.service";
import { SignFieldsController } from "./sign-fields.controller";
import { SignEnvelopesService } from "./sign-envelopes.service";
import { SignEnvelopesController } from "./sign-envelopes.controller";

@Module({
  imports: [StorageModule, EmailModule, AccessModule],
  controllers: [SignDocumentsController, SignRecipientsController, SignFieldsController, SignEnvelopesController],
  providers: [
    SignAuditService,
    SignTokensService,
    SignPdfService,
    SignSettingsService,
    SignNotificationsService,
    SignDocumentsService,
    SignRecipientsService,
    SignFieldsService,
    SignEnvelopesService,
  ],
  exports: [SignAuditService, SignSettingsService, SignEnvelopesService],
})
export class SignosModule {}
