import { Module } from "@nestjs/common";
import { EmploymentFactsService } from "./employment-facts.service";
import { EmploymentFactsController } from "./employment-facts.controller";
import { ReportingLineService } from "./reporting-line.service";
import { ApprovalAuthorityService } from "./approval-authority.service";
import { ApprovalAuthorityController } from "./approval-authority.controller";
import { DirectReportsService } from "./direct-reports.service";

@Module({
  controllers: [EmploymentFactsController, ApprovalAuthorityController],
  providers: [EmploymentFactsService, ReportingLineService, ApprovalAuthorityService, DirectReportsService],
  exports: [EmploymentFactsService, ReportingLineService, ApprovalAuthorityService, DirectReportsService],
})
export class EmploymentFactsModule {}
