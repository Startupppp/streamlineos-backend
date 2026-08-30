import { Module } from "@nestjs/common";
import { WorkflowModule } from "../../../common/workflow/workflow.module";
import { IntegrationsModule } from "../../integrations/core/integrations.module";
import { CrmImportController } from "./crm-import.controller";
import { CrmImportService } from "./crm-import.service";
import { CrmImportPreviewService } from "./crm-import-preview.service";
import { CrmImportCommitService } from "./crm-import-commit.service";
import { CrmImportRevertService } from "./crm-import-revert.service";
import { CrmExportService } from "./crm-export.service";
import { CrmImportWorkflow } from "./crm-import.workflow";
import { ImportPump } from "./import-pump";
import { CrmConnectorService } from "./crm-connector.service";
import { CrmConnectorWalkService } from "./crm-connector-walk.service";
import { CrmConnectorLifecycleService } from "./crm-connector-lifecycle.service";
import { CrmConnectorWorkflow } from "./crm-connector.workflow";

/**
 * Bringing a competitor's export in, and taking everything back out.
 *
 * Both halves live together because they are the same promise read in two
 * directions: that a tenant's data is theirs, and that arriving and leaving are
 * both cheap.
 */
@Module({
  imports: [WorkflowModule, IntegrationsModule],
  controllers: [CrmImportController],
  providers: [
    CrmImportPreviewService,
    CrmImportCommitService,
    CrmImportRevertService,
    CrmImportService,
    CrmExportService,
    CrmImportWorkflow,
    CrmConnectorWalkService,
    CrmConnectorLifecycleService,
    CrmConnectorService,
    CrmConnectorWorkflow,
    ImportPump,
  ],
  exports: [CrmImportService, CrmExportService, CrmConnectorService],
})
export class CrmImportModule {}
