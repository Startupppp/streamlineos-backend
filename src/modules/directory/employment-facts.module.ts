import { Module } from "@nestjs/common";
import { EmploymentFactsService } from "./employment-facts.service";
import { EmploymentFactsController } from "./employment-facts.controller";
import { ReportingLineService } from "./reporting-line.service";
import { ApprovalAuthorityService } from "./approval-authority.service";
import { ApprovalAuthorityController } from "./approval-authority.controller";
import { DirectReportsService } from "./direct-reports.service";
import { ReportingManagerPolicyService } from "./reporting-manager-policy.service";
import { ReportingManagerFallbackResolver } from "./reporting-manager-fallback.resolver";
import { ReportingRelationshipService } from "./reporting-relationship.service";

@Module({
  controllers: [EmploymentFactsController, ApprovalAuthorityController],
  providers: [
    EmploymentFactsService,
    ReportingLineService,
    ApprovalAuthorityService,
    DirectReportsService,
    ReportingManagerPolicyService,
    ReportingManagerFallbackResolver,
    ReportingRelationshipService,
  ],
  exports: [
    EmploymentFactsService,
    ReportingLineService,
    ApprovalAuthorityService,
    DirectReportsService,
    ReportingManagerPolicyService,
    ReportingManagerFallbackResolver,
    ReportingRelationshipService,
  ],
})
export class EmploymentFactsModule {}
