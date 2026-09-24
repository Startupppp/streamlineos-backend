import { Module } from "@nestjs/common";
import { KbCoreModule } from "../core/kb-core.module";
import { KbLinkedDocumentCeilingService } from "./kb-linked-document-ceiling.service";
import { KbLinkedDocumentFileService } from "./kb-linked-document-file.service";
import { KbLinkedDocumentPublishService } from "./kb-linked-document-publish.service";
import { KbLinkedDocumentQueryService } from "./kb-linked-document-query.service";
import { KbLinkedDocumentsController } from "./kb-linked-documents.controller";

@Module({
  imports: [KbCoreModule],
  controllers: [KbLinkedDocumentsController],
  providers: [KbLinkedDocumentCeilingService, KbLinkedDocumentQueryService, KbLinkedDocumentFileService, KbLinkedDocumentPublishService],
  exports: [KbLinkedDocumentCeilingService, KbLinkedDocumentQueryService, KbLinkedDocumentPublishService],
})
export class KbLinkedDocumentsModule {}
