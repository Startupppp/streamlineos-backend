import { Module } from "@nestjs/common";
import { OutboxModule } from "../../common/outbox/outbox.module";
import { GdprController } from "./gdpr.controller";
import { GdprService } from "./gdpr.service";
import { GdprExportService } from "./gdpr-export.service";
import { GdprExportWorkerService } from "./gdpr-export-worker.service";
import { GdprExportRequestedConsumer } from "./gdpr-export-outbox.consumer";
import { GdprStoragePurgeService } from "./gdpr-storage-purge.service";
import { GdprRectificationService } from "./gdpr-rectification.service";

@Module({
  imports: [OutboxModule],
  controllers: [GdprController],
  providers: [
    GdprService,
    GdprExportService,
    GdprExportWorkerService,
    GdprExportRequestedConsumer,
    GdprStoragePurgeService,
    GdprRectificationService,
  ],
  exports: [GdprService, GdprExportService, GdprStoragePurgeService, GdprRectificationService],
})
export class GdprModule {}
