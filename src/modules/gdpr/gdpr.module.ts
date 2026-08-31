import { Module } from "@nestjs/common";
import { GdprController } from "./gdpr.controller";
import { GdprService } from "./gdpr.service";
import { GdprExportService } from "./gdpr-export.service";
import { GdprExportWorkerService } from "./gdpr-export-worker.service";
import { GdprStoragePurgeService } from "./gdpr-storage-purge.service";

@Module({
  controllers: [GdprController],
  providers: [GdprService, GdprExportService, GdprExportWorkerService, GdprStoragePurgeService],
  exports: [GdprService, GdprExportService, GdprStoragePurgeService],
})
export class GdprModule {}
