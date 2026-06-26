import { Module } from "@nestjs/common";
import { LeaveCalendarController, LeavesController } from "./leaves.controller";
import { AttendanceController } from "./attendance.controller";
import { WfhController } from "./wfh.controller";
import { WorkLogsController } from "./work-logs.controller";
import { LeavesService } from "./leaves.service";
import { AttendanceService } from "./attendance.service";
import { WfhService } from "./wfh.service";
import { WorkLogsService } from "./work-logs.service";

@Module({
  controllers: [
    LeavesController,
    LeaveCalendarController,
    AttendanceController,
    WfhController,
    WorkLogsController,
  ],
  providers: [LeavesService, AttendanceService, WfhService, WorkLogsService],
})
export class HrTimeModule {}
