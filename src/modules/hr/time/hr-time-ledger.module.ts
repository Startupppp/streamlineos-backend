import { Module } from "@nestjs/common";
import { AttendancePolicyModule } from "./attendance-policy.module";
import { AttendanceSummaryService } from "./attendance-summary.service";
import { LeaveLedgerService } from "./leave-ledger.service";

@Module({
  imports: [AttendancePolicyModule],
  providers: [AttendanceSummaryService, LeaveLedgerService],
  exports: [AttendancePolicyModule, AttendanceSummaryService, LeaveLedgerService],
})
export class HrTimeLedgerModule {}
