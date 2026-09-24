import { Module } from "@nestjs/common";
import { KbCoreModule } from "../core/kb-core.module";
import { KbLinkedDocumentAskSource } from "./kb-linked-document-ask-source";
import { KbLinkedDocumentCeilingService } from "./kb-linked-document-ceiling.service";
import { KbLinkedDocumentFileService } from "./kb-linked-document-file.service";
import { KbLinkedDocumentPublishService } from "./kb-linked-document-publish.service";
import { KbLinkedDocumentQueryService } from "./kb-linked-document-query.service";
import { KbLinkedDocumentsController } from "./kb-linked-documents.controller";

@Module({
  imports: [KbCoreModule],
  controllers: [KbLinkedDocumentsController],
  providers: [KbLinkedDocumentAskSource, KbLinkedDocumentCeilingService, KbLinkedDocumentQueryService, KbLinkedDocumentFileService, KbLinkedDocumentPublishService],
  exports: [KbLinkedDocumentAskSource, KbLinkedDocumentCeilingService, KbLinkedDocumentQueryService, KbLinkedDocumentPublishService],
})
export class KbLinkedDocumentsModule {}
