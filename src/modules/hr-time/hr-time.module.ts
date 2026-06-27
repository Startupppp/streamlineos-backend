import { Module } from "@nestjs/common";
import { AutomationModule } from "../automation/automation.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { LeaveCalendarController, LeavesController } from "./leaves.controller";
import { AttendanceController } from "./attendance.controller";
import { WfhController } from "./wfh.controller";
import { WorkLogsController } from "./work-logs.controller";
import { LeavesService } from "./leaves.service";
import { LeavesWriteService } from "./leaves-write.service";
import { LeavesPageService } from "./leaves-page.service";
import { AttendanceService } from "./attendance.service";
import { WfhService } from "./wfh.service";
import { WorkLogsService } from "./work-logs.service";

@Module({
  imports: [AutomationModule, WebhooksModule],
  controllers: [
    LeavesController,
    LeaveCalendarController,
    AttendanceController,
    WfhController,
    WorkLogsController,
  ],
  providers: [
    LeavesService,
    LeavesWriteService,
    LeavesPageService,
    AttendanceService,
    WfhService,
    WorkLogsService,
  ],
})
export class HrTimeModule {}
