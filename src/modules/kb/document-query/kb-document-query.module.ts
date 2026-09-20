import { Module } from "@nestjs/common";
import { KbCoreModule } from "../core/kb-core.module";
import { KbDocumentQueryService } from "./kb-document-query.service";

@Module({
  imports: [KbCoreModule],
  providers: [KbDocumentQueryService],
  exports: [KbDocumentQueryService],
})
export class KbDocumentQueryModule {}
