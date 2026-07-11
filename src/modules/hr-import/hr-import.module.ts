import { Module } from "@nestjs/common";
import { HrCoreModule } from "../hr-core/hr-core.module";
import { HrImportController } from "./hr-import.controller";
import { HrImportService } from "./hr-import.service";
import { HrImportCommitService } from "./hr-import-commit.service";

@Module({
  imports: [HrCoreModule],
  controllers: [HrImportController],
  providers: [HrImportService, HrImportCommitService],
})
export class HrImportModule {}
