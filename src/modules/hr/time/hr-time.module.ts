import { Module } from "@nestjs/common";
import { AutomationModule } from "../../automation/automation.module";
import { WebhooksModule } from "../../webhooks/webhooks.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { HrAutomationsModule } from "../automations/hr-automations.module";
import { HrPoliciesModule } from "../policies/hr-policies.module";
import { HrWorkflowsModule } from "../workflows/hr-workflows.module";
import { HrPayrollInputsModule } from "../payroll-inputs/hr-payroll-inputs.module";
import { LeaveCalendarController, LeavesController } from "./leaves.controller";
import { AttendanceController } from "./attendance.controller";
import { AttendanceRegularizationController } from "./attendance-regularization.controller";
import { AttendanceSummaryController } from "./attendance-summary.controller";
import { WfhController } from "./wfh.controller";
import { WorkLogsController } from "./work-logs.controller";
import { ShiftsController } from "./shifts.controller";
import { RostersController } from "./rosters.controller";
import { OvertimeController } from "./overtime.controller";
import { GeofencingController } from "./geofencing.controller";
import { BiometricController } from "./biometric.controller";
import { LeavePoliciesController } from "./leave-policies.controller";
import { LeavePolicySummaryController } from "./leave-policy-summary.controller";
import { EmployeeAttendanceController } from "./employee-attendance.controller";
import { EmployeeTimeOffController } from "./employee-time-off.controller";
import { LeavesService } from "./leaves.service";
import { LeavesWriteService } from "./leaves-write.service";
import { LeavesApprovalService } from "./leaves-approval.service";
import { LeaveDecisionEffectsService } from "./leave-decision-effects.service";
import { LeavesPageService } from "./leaves-page.service";
import { AttendanceService } from "./attendance.service";
import { AttendanceClockService } from "./attendance-clock.service";
import { AttendanceReadService } from "./attendance-read.service";
import { AttendanceEventWriterService } from "./attendance-event-writer.service";
import { HrTimeLedgerModule } from "./hr-time-ledger.module";
import { AttendanceRegularizationService } from "./attendance-regularization.service";
import { WfhService } from "./wfh.service";
import { WorkLogsService } from "./work-logs.service";
import { ShiftsService } from "./shifts.service";
import { RostersService } from "./rosters.service";
import { OvertimeService } from "./overtime.service";
import { GeofencingService } from "./geofencing.service";
import { BiometricService } from "./biometric.service";
import { LeavePoliciesService } from "./leave-policies.service";
import { CompOffGrantService } from "./comp-off-grant.service";
import { LeaveApproverService } from "./leave-approver.service";
import { LeaveTypesService } from "./leave-types.service";
import { RateLimitModule } from "../../../common/ratelimit/rate-limit.module";

@Module({
  imports: [
    AutomationModule,
    WebhooksModule,
    NotificationsModule,
    HrAutomationsModule,
    HrPoliciesModule,
    HrTimeLedgerModule,
    HrWorkflowsModule,
    HrPayrollInputsModule,
    RateLimitModule,
  ],
  controllers: [
    EmployeeAttendanceController,
    EmployeeTimeOffController,
    LeavesController,
    LeaveCalendarController,
    AttendanceController,
    AttendanceRegularizationController,
    AttendanceSummaryController,
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
    LeavesApprovalService,
    LeaveDecisionEffectsService,
    LeavesPageService,
    AttendanceClockService,
    AttendanceEventWriterService,
    AttendanceReadService,
    AttendanceService,
    AttendanceRegularizationService,
    WfhService,
    WorkLogsService,
    ShiftsService,
    RostersService,
    OvertimeService,
    GeofencingService,
    BiometricService,
    LeavePoliciesService,
    CompOffGrantService,
    LeaveApproverService,
    LeaveTypesService,
  ],
  exports: [AttendanceService, HrTimeLedgerModule, LeavesService, WfhService],
})
export class HrTimeModule {}
