import { Module } from "@nestjs/common";
import { TestSuitesController } from "./test-suites.controller";
import { TestCasesController } from "./test-cases.controller";
import { TestRunsController } from "./test-runs.controller";
import { BugsController } from "./bugs.controller";
import { TestManagementService } from "./test-management.service";
import { TestRunsService } from "./test-runs.service";
import { BugsService } from "./bugs.service";

@Module({
  controllers: [
    TestSuitesController,
    TestCasesController,
    TestRunsController,
    BugsController,
  ],
  providers: [
    TestManagementService,
    TestRunsService,
    BugsService,
  ],
})
export class BuildQaModule {}
