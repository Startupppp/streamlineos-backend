import { Module } from "@nestjs/common";
import { HrCoreModule } from "../core/hr-core.module";
import { HrImportController } from "./hr-import.controller";
import { HrImportService } from "./hr-import.service";
import { HrImportCommitService } from "./hr-import-commit.service";
import { HrExportController } from "./hr-export.controller";
import { HrExportJobsService } from "./hr-export-jobs.service";
import { HrExportFileService } from "./hr-export-file.service";
import { HrExportWorkerService } from "./hr-export-worker.service";

@Module({
  imports: [HrCoreModule],
  controllers: [HrImportController, HrExportController],
  providers: [
    HrImportService,
    HrImportCommitService,
    HrExportJobsService,
    HrExportFileService,
    HrExportWorkerService,
  ],
})
export class HrImportModule {}
