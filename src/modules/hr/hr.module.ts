import { Module } from "@nestjs/common";
import { HrConfigModule } from "./config/hr-config.module";
import { HrTimeModule } from "./time/hr-time.module";
import { HrDirectoryModule } from "./directory/hr-directory.module";
import { HrPerformanceModule } from "./performance/hr-performance.module";
import { HrPayrollModule } from "../payroll/hr-payroll/hr-payroll.module";
import { HrLifecycleModule } from "./lifecycle/hr-lifecycle.module";
import { HrCoreModule } from "./core/hr-core.module";
import { HrAutomationsModule } from "./automations/hr-automations.module";
import { HrPoliciesModule } from "./policies/hr-policies.module";
import { HrWorkflowsModule } from "./workflows/hr-workflows.module";
import { HrTemplatesModule } from "./templates/hr-templates.module";
import { HrPayrollInputsModule } from "./payroll-inputs/hr-payroll-inputs.module";
import { HrCasesModule } from "./cases/hr-cases.module";
import { HrBenefitsModule } from "./benefits/hr-benefits.module";
import { HrGlobalModule } from "./global/hr-global.module";
import { HrFormsModule } from "./forms/hr-forms.module";
import { HrAnalyticsPlusModule } from "./analytics-plus/hr-analytics-plus.module";
import { HrSettingsHubModule } from "./settings-hub/hr-settings-hub.module";
import { HrGovernanceModule } from "./governance/hr-governance.module";
import { HrEnterpriseCompModule } from "./enterprise-comp/hr-enterprise-comp.module";
import { HrEnterpriseOpsModule } from "./enterprise-ops/hr-enterprise-ops.module";
import { HrHelpdeskModule } from "./helpdesk/hr-helpdesk.module";
import { HrRecruitmentModule } from "./recruitment/hr-recruitment.module";
import { HrInterviewsModule } from "./interviews/hr-interviews.module";
import { HrImportModule } from "./import/hr-import.module";
import { OnboardingRootModule } from "./onboarding/onboarding.module";
import { HrHubModule } from "./hub/hr-hub.module";
import { HrCalendarModule } from "./hr-calendar.module";

const HR_MODULES = [
  HrConfigModule,
  HrTimeModule,
  HrDirectoryModule,
  HrPerformanceModule,
  HrPayrollModule,
  HrLifecycleModule,
  HrCoreModule,
  HrAutomationsModule,
  HrPoliciesModule,
  HrWorkflowsModule,
  HrTemplatesModule,
  HrPayrollInputsModule,
  HrCasesModule,
  HrBenefitsModule,
  HrGlobalModule,
  HrFormsModule,
  HrAnalyticsPlusModule,
  HrSettingsHubModule,
  HrGovernanceModule,
  HrEnterpriseCompModule,
  HrEnterpriseOpsModule,
  HrHelpdeskModule,
  HrRecruitmentModule,
  HrInterviewsModule,
  HrImportModule,
  OnboardingRootModule,
  HrHubModule,
  HrCalendarModule,
];

@Module({
  imports: HR_MODULES,
  exports: HR_MODULES,
})
export class HrModule {}
