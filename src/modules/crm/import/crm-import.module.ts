import { Module } from "@nestjs/common";
import { WorkflowModule } from "../../../common/workflow/workflow.module";
import { IntegrationsModule } from "../../integrations/core/integrations.module";
import { CrmImportController } from "./crm-import.controller";
import { CrmImportService } from "./crm-import.service";
import { CrmExportService } from "./crm-export.service";
import { CrmImportWorkflow } from "./crm-import.workflow";
import { ImportPump } from "./import-pump";
import { CrmConnectorService } from "./crm-connector.service";
import { CrmConnectorWorkflow } from "./crm-connector.workflow";

/**
 * Bringing a competitor's export in, and taking everything back out.
 *
 * Both halves live together because they are the same promise read in two
 * directions: that a tenant's data is theirs, and that arriving and leaving are
 * both cheap.
 */
@Module({
  // `IntegrationsModule` for `ComposioGateway` only. Nothing here touches
  // `IntegrationsService`, and nothing writes `user_integration_connections`:
  // the connectors read that table as a mirror and go out through the gateway.
  imports: [WorkflowModule, IntegrationsModule],
  controllers: [CrmImportController],
  providers: [
    CrmImportService,
    CrmExportService,
    CrmImportWorkflow,
    CrmConnectorService,
    CrmConnectorWorkflow,
    ImportPump,
  ],
  exports: [CrmImportService, CrmExportService, CrmConnectorService],
})
export class CrmImportModule {}
