import { Module } from "@nestjs/common";
import { WorkflowModule } from "../../common/workflow/workflow.module";
import { CrmImportController } from "./crm-import.controller";
import { CrmImportService } from "./crm-import.service";
import { CrmExportService } from "./crm-export.service";
import { CrmImportWorkflow } from "./crm-import.workflow";

/**
 * Bringing a competitor's export in, and taking everything back out.
 *
 * Both halves live together because they are the same promise read in two
 * directions: that a tenant's data is theirs, and that arriving and leaving are
 * both cheap.
 */
@Module({
  imports: [WorkflowModule],
  controllers: [CrmImportController],
  providers: [CrmImportService, CrmExportService, CrmImportWorkflow],
  exports: [CrmImportService, CrmExportService],
})
export class CrmImportModule {}
