import { Module } from "@nestjs/common";
import { OutboxModule } from "../../common/outbox/outbox.module";
import { GdprController } from "./gdpr.controller";
import { GdprService } from "./gdpr.service";
import { GdprExportService } from "./gdpr-export.service";
import { GdprExportWorkerService } from "./gdpr-export-worker.service";
import { GdprExportRequestedConsumer } from "./gdpr-export-outbox.consumer";
import { GdprStoragePurgeService } from "./gdpr-storage-purge.service";
import { GdprRectificationService } from "./gdpr-rectification.service";
import { GdprSubjectErasureService } from "./gdpr-subject-erasure.service";
import { SessionsModule } from "../sessions/sessions.module";

@Module({
  imports: [OutboxModule, SessionsModule],
  controllers: [GdprController],
  providers: [
    GdprService,
    GdprExportService,
    GdprExportWorkerService,
    GdprExportRequestedConsumer,
    GdprStoragePurgeService,
    GdprRectificationService,
    GdprSubjectErasureService,
  ],
  exports: [GdprService, GdprExportService, GdprStoragePurgeService, GdprRectificationService, GdprSubjectErasureService],
})
export class GdprModule {}
