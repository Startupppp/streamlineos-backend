import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { AutomationModule } from "../automation/automation.module";
import { LeadsController } from "./leads.controller";
import { LeadsIngestController } from "./leads.ingest.controller";
import { LeadsReportsController } from "./leads-reports.controller";
import { LeadsDetailController } from "./leads-detail.controller";
import { LeadsOpsController } from "./leads-ops.controller";
import { LeadsService } from "./leads.service";
import { LeadsReportsService } from "./leads-reports.service";
import { LeadsExportsService } from "./leads-exports.service";
import { LeadsDetailService } from "./leads-detail.service";
import { LeadStatusService } from "./lead-status.service";
import { LeadsOpsService } from "./leads-ops.service";

@Module({
  imports: [NotificationsModule, AutomationModule],
  controllers: [
    LeadsReportsController,
    LeadsOpsController,
    LeadsDetailController,
    LeadsController,
    LeadsIngestController,
  ],
  providers: [
    LeadsService,
    LeadsReportsService,
    LeadsExportsService,
    LeadsDetailService,
    LeadStatusService,
    LeadsOpsService,
  ],
})
export class LeadsModule {}
