import { Module } from "@nestjs/common";
import { EmploymentFactsService } from "./employment-facts.service";
import { EmploymentFactsController } from "./employment-facts.controller";
import { ReportingLineService } from "./reporting-line.service";
import { ApprovalAuthorityService } from "./approval-authority.service";

@Module({
  controllers: [EmploymentFactsController],
  providers: [EmploymentFactsService, ReportingLineService, ApprovalAuthorityService],
  exports: [EmploymentFactsService, ReportingLineService, ApprovalAuthorityService],
})
export class EmploymentFactsModule {}
