import { Module } from "@nestjs/common";
import { AutomationModule } from "../automation/automation.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { LeaveCalendarController, LeavesController } from "./leaves.controller";
import { AttendanceController } from "./attendance.controller";
import { WfhController } from "./wfh.controller";
import { WorkLogsController } from "./work-logs.controller";
import { ShiftsController } from "./shifts.controller";
import { RostersController } from "./rosters.controller";
import { OvertimeController } from "./overtime.controller";
import { GeofencingController } from "./geofencing.controller";
import { BiometricController } from "./biometric.controller";
import { LeavePoliciesController } from "./leave-policies.controller";
import { LeavePolicySummaryController } from "./leave-policy-summary.controller";
import { LeavesService } from "./leaves.service";
import { LeavesWriteService } from "./leaves-write.service";
import { LeavesPageService } from "./leaves-page.service";
import { AttendanceService } from "./attendance.service";
import { WfhService } from "./wfh.service";
import { WorkLogsService } from "./work-logs.service";
import { ShiftsService } from "./shifts.service";
import { RostersService } from "./rosters.service";
import { OvertimeService } from "./overtime.service";
import { GeofencingService } from "./geofencing.service";
import { BiometricService } from "./biometric.service";
import { LeavePoliciesService } from "./leave-policies.service";

@Module({
  imports: [AutomationModule, WebhooksModule, NotificationsModule],
  controllers: [
    LeavesController,
    LeaveCalendarController,
    AttendanceController,
    WfhController,
    WorkLogsController,
    ShiftsController,
    RostersController,
    OvertimeController,
    GeofencingController,
    BiometricController,
    LeavePoliciesController,
    LeavePolicySummaryController,
  ],
  providers: [
    LeavesService,
    LeavesWriteService,
    LeavesPageService,
    AttendanceService,
    WfhService,
    WorkLogsService,
    ShiftsService,
    RostersService,
    OvertimeService,
    GeofencingService,
    BiometricService,
    LeavePoliciesService,
  ],
})
export class HrTimeModule {}
