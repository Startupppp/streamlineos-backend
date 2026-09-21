import { Module } from "@nestjs/common";
import { EmploymentFactsService } from "./employment-facts.service";
import { EmploymentFactsController } from "./employment-facts.controller";
import { ReportingLineService } from "./reporting-line.service";
import { ApprovalAuthorityService } from "./approval-authority.service";
import { ApprovalAuthorityController } from "./approval-authority.controller";

@Module({
  controllers: [EmploymentFactsController, ApprovalAuthorityController],
  providers: [EmploymentFactsService, ReportingLineService, ApprovalAuthorityService],
  exports: [EmploymentFactsService, ReportingLineService, ApprovalAuthorityService],
})
export class EmploymentFactsModule {}
