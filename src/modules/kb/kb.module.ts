import { Module } from "@nestjs/common";
import { KbCoreModule } from "./core/kb-core.module";
import { KbRetrievalModule } from "./retrieval/kb-retrieval.module";
import { KbHelpCentreModule } from "./help-centre/kb-help-centre.module";
import { KbWikiModule } from "./wiki/kb-wiki.module";
import { KbLinkedDocumentsModule } from "./linked-documents/kb-linked-documents.module";

const KB_MODULES = [KbCoreModule, KbRetrievalModule, KbHelpCentreModule, KbWikiModule, KbLinkedDocumentsModule];

@Module({
  imports: KB_MODULES,
  exports: KB_MODULES,
})
export class KbModule {}
