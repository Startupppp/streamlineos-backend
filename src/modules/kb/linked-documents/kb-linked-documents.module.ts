import { Module } from "@nestjs/common";
import { KbLinkedDocumentCeilingService } from "./kb-linked-document-ceiling.service";

@Module({
  providers: [KbLinkedDocumentCeilingService],
  exports: [KbLinkedDocumentCeilingService],
})
export class KbLinkedDocumentsModule {}
