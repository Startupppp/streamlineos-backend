import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Reflector } from "@nestjs/core";
import { ConfigModule } from "./config/config.module";
import { JwtAuthGuard } from "./common/auth/jwt-auth.guard";
import { DrizzleModule } from "./db/drizzle.module";
import { CacheModule } from "./common/cache/cache.module";
import { AuditModule } from "./common/audit/audit.module";
import { RateLimitModule } from "./common/ratelimit/rate-limit.module";
import { LeadsModule } from "./modules/leads/leads.module";
import { ContactsModule } from "./modules/contacts/contacts.module";
import { TargetsModule } from "./modules/targets/targets.module";
import { CsatModule } from "./modules/csat/csat.module";
import { SurveysModule } from "./modules/surveys/surveys.module";
import { BlogModule } from "./modules/blog/blog.module";
import { AuditLogModule } from "./modules/audit-log/audit-log.module";
import { GoalsModule } from "./modules/goals/goals.module";
import { ExpensesModule } from "./modules/expenses/expenses.module";
import { TasksModule } from "./modules/tasks/tasks.module";
import { PlatformModule } from "./modules/platform/platform.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { PushModule } from "./modules/push/push.module";
import { QuotesModule } from "./modules/quotes/quotes.module";
import { CustomerExecutiveModule } from "./modules/customer-executive/customer-executive.module";
import { ReportsModule } from "./modules/reports/reports.module";
import { SalesModule } from "./modules/sales/sales.module";
import { CalendarModule } from "./modules/calendar/calendar.module";
import { SettingsModule } from "./modules/settings/settings.module";
import { InvoicesModule } from "./modules/invoices/invoices.module";
import { CareersModule } from "./modules/careers/careers.module";
import { OnboardingModule } from "./modules/onboarding/onboarding.module";
import { WebhooksModule } from "./modules/webhooks/webhooks.module";
import { ClientsModule } from "./modules/clients/clients.module";
import { CrmModule } from "./modules/crm/crm.module";
import { DashboardModule } from "./modules/dashboard/dashboard.module";
import { PublicModule } from "./modules/public/public.module";
import { RbacModule } from "./modules/rbac/rbac.module";
import { AccessModule } from "./modules/access/access.module";
import { DealsModule } from "./modules/deals/deals.module";
import { OrgModule } from "./modules/org/org.module";
import { OrganizationModule } from "./modules/organization/organization.module";
import { BranchesModule } from "./modules/branches/branches.module";
import { ProjectsExecutionModule } from "./modules/projects-execution/projects-execution.module";
import { ProjectsQaModule } from "./modules/projects-qa/projects-qa.module";
import { ProjectsClientPortalModule } from "./modules/projects-client-portal/projects-client-portal.module";
import { ProjectsApprovalsModule } from "./modules/projects-approvals/projects-approvals.module";
import { ProjectsGovernanceModule } from "./modules/projects-governance/projects-governance.module";
import { ProjectsMeetingsModule } from "./modules/projects-meetings/projects-meetings.module";
import { ProjectsPortfoliosModule } from "./modules/projects-portfolios/projects-portfolios.module";
import { ProjectsTeamsModule } from "./modules/projects-teams/projects-teams.module";
import { ProjectsCommentDraftsModule } from "./modules/projects-comment-drafts/projects-comment-drafts.module";
import { ProjectsIncidentsModule } from "./modules/projects-incidents/projects-incidents.module";
import { ProjectsWorkflowModule } from "./modules/projects-workflow/projects-workflow.module";
import { ProjectsFormsModule } from "./modules/projects-forms/projects-forms.module";
import { ProjectsModule } from "./modules/projects/projects.module";
import { ProjectsByIdModule } from "./modules/projects/projects-by-id.module";
import { SupportModule } from "./modules/support/support.module";
import { SignosModule } from "./modules/signos/signos.module";
import { KbModule } from "./modules/kb/kb.module";
import { AccountingModule } from "./modules/accounting/accounting.module";
import { ChatModule } from "./modules/chat/chat.module";
import { HrConfigModule } from "./modules/hr-config/hr-config.module";
import { HrTimeModule } from "./modules/hr-time/hr-time.module";
import { HrDirectoryModule } from "./modules/hr-directory/hr-directory.module";
import { HrPerformanceModule } from "./modules/hr-performance/hr-performance.module";
import { HrPayrollModule } from "./modules/hr-payroll/hr-payroll.module";
import { HrLifecycleModule } from "./modules/hr-lifecycle/hr-lifecycle.module";
import { HrCoreModule } from "./modules/hr-core/hr-core.module";
import { HrAutomationsModule } from "./modules/hr-automations/hr-automations.module";
import { HrPoliciesModule } from "./modules/hr-policies/hr-policies.module";
import { HrWorkflowsModule } from "./modules/hr-workflows/hr-workflows.module";
import { HrTemplatesModule } from "./modules/hr-templates/hr-templates.module";
import { HrPayrollInputsModule } from "./modules/hr-payroll-inputs/hr-payroll-inputs.module";
import { HrCasesModule } from "./modules/hr-cases/hr-cases.module";
import { HrBenefitsModule } from "./modules/hr-benefits/hr-benefits.module";
import { HrGlobalModule } from "./modules/hr-global/hr-global.module";
import { HrFormsModule } from "./modules/hr-forms/hr-forms.module";
import { HrAnalyticsPlusModule } from "./modules/hr-analytics-plus/hr-analytics-plus.module";
import { HrSettingsHubModule } from "./modules/hr-settings-hub/hr-settings-hub.module";
import { HrGovernanceModule } from "./modules/hr-governance/hr-governance.module";
import { HrEnterpriseCompModule } from "./modules/hr-enterprise-comp/hr-enterprise-comp.module";
import { HrEnterpriseOpsModule } from "./modules/hr-enterprise-ops/hr-enterprise-ops.module";
import { SearchModule } from "./modules/search/search.module";
import { IntegrationsGitModule } from "./modules/integrations-git/integrations-git.module";
import { IntegrationsModule } from "./modules/integrations/integrations.module";
import { CronModule } from "./modules/cron/cron.module";
import { HrHelpdeskModule } from "./modules/hr-helpdesk/hr-helpdesk.module";
import { HrRecruitmentModule } from "./modules/hr-recruitment/hr-recruitment.module";
import { HrInterviewsModule } from "./modules/hr-interviews/hr-interviews.module";
import { InvProductsModule } from "./modules/inv-products/inv-products.module";
import { InvWarehousesModule } from "./modules/inv-warehouses/inv-warehouses.module";
import { InvStockModule } from "./modules/inv-stock/inv-stock.module";
import { InvVendorsModule } from "./modules/inv-vendors/inv-vendors.module";
import { InvPurchaseOrdersModule } from "./modules/inv-purchase-orders/inv-purchase-orders.module";
import { InvSalesOrdersModule } from "./modules/inv-sales-orders/inv-sales-orders.module";
import { InvReportsModule } from "./modules/inv-reports/inv-reports.module";
import { InvBarcodeModule } from "./modules/inv-barcode/inv-barcode.module";
import { InvCountsModule } from "./modules/inv-counts/inv-counts.module";
import { InvReturnsModule } from "./modules/inv-returns/inv-returns.module";
import { InvTraceabilityModule } from "./modules/inv-traceability/inv-traceability.module";
import { InvValuationModule } from "./modules/inv-valuation/inv-valuation.module";
import { InvReplenishmentModule } from "./modules/inv-replenishment/inv-replenishment.module";
import { InvAiModule } from "./modules/inv-ai/inv-ai.module";
import { InvQualityModule } from "./modules/inv-quality/inv-quality.module";
import { InvShipmentsModule } from "./modules/inv-shipments/inv-shipments.module";
import { InvChannelsModule } from "./modules/inv-channels/inv-channels.module";
import { InvImportExportModule } from "./modules/inv-import-export/inv-import-export.module";
import { InvWebhooksModule } from "./modules/inv-webhooks/inv-webhooks.module";
import { InvSettingsModule } from "./modules/inv-settings/inv-settings.module";
import { EmailModule } from "./modules/email/email.module";
import { AiModule } from "./modules/ai/ai.module";
import { AiSummariesModule } from "./modules/ai-summaries/ai-summaries.module";
import { WorkspaceSearchModule } from "./modules/workspace-search/workspace-search.module";
import { SupportKbGapModule } from "./modules/support-kb-gap";
import { StorageModule } from "./modules/storage/storage.module";
import { BillingModule } from "./modules/billing/billing.module";
import { RealtimeModule } from "./modules/realtime/realtime.module";
import { AutomationModule } from "./modules/automation/automation.module";
import { SessionsModule } from "./modules/sessions/sessions.module";
import { MfaModule } from "./modules/mfa/mfa.module";
import { AuthModule } from "./modules/auth/auth.module";
import { FeatureFlagsModule } from "./modules/feature-flags/feature-flags.module";
import { AiJobsModule } from "./modules/ai-jobs/ai-jobs.module";
import { AiConfirmationModule } from "./modules/ai-confirmation";
import { OrgHierarchyModule } from "./modules/org-hierarchy/org-hierarchy.module";
import { ApiTokensModule } from "./modules/api-tokens/api-tokens.module";
import { ServiceAccountsModule } from "./modules/service-accounts/service-accounts.module";
import { UserApiTokensModule } from "./modules/user-api-tokens/user-api-tokens.module";
import { TemporaryAccessModule } from "./modules/temporary-access/temporary-access.module";
import { DelegationsModule } from "./modules/delegations/delegations.module";
import { UsersModule } from "./modules/users/users.module";
import { WorkspaceOnboardingModule } from "./modules/workspace-onboarding/workspace-onboarding.module";
import { WorkflowsModule } from "./modules/workflows/workflows.module";
import { PayrollModule } from "./modules/payroll/payroll.module";
import { TimesheetsModule } from "./modules/timesheets/timesheets.module";
import { TimesheetsCoreModule } from "./modules/timesheets-core/timesheets-core.module";
import { PaymentsModule } from "./modules/payments/payments.module";
import { FeedbucketModule } from "./modules/feedbucket/feedbucket.module";
import { HrImportModule } from "./modules/hr-import/hr-import.module";
import { CrmMetadataModule } from "./modules/crm-metadata/crm-metadata.module";
import { CrmPricebooksModule } from "./modules/crm-pricebooks/crm-pricebooks.module";
import { CrmInboxModule } from "./modules/crm-inbox/crm-inbox.module";
import { CrmAutomationStudioModule } from "./modules/crm-automation-studio/crm-automation-studio.module";
import { FinanceReportsModule } from "./modules/finance-reports/finance-reports.module";
import { FinanceExpensesModule } from "./modules/finance-expenses/finance-expenses.module";
import { AccountingSettingsModule } from "./modules/accounting-settings/accounting-settings.module";
import { AccountingGlModule } from "./modules/accounting-gl/accounting-gl.module";
import { FinanceArModule } from "./modules/finance-ar/finance-ar.module";
import { FinanceApModule } from "./modules/finance-ap/finance-ap.module";
import { FinanceBankingModule } from "./modules/finance-banking/finance-banking.module";
import { FinanceTaxModule } from "./modules/finance-tax/finance-tax.module";
import { FinancePlanningModule } from "./modules/finance-planning/finance-planning.module";
import { FinanceAssetsModule } from "./modules/finance-assets/finance-assets.module";
import { FinanceControlsModule } from "./modules/finance-controls/finance-controls.module";
import { AccountingAiModule } from "./modules/accounting-ai/accounting-ai.module";
import { AgentAccessModule } from "./modules/agent-access/agent-access.module";
import { MailModule } from "./modules/mail/mail.module";
import { HealthController } from "./health/health.controller";
import { MeController } from "./me/me.controller";
import { MeService } from "./me/me.service";

@Module({
  imports: [
    ConfigModule,
    DrizzleModule,
    CacheModule,
    AuditModule,
    RateLimitModule,
    LeadsModule,
    ContactsModule,
    TargetsModule,
    CsatModule,
    SurveysModule,
    BlogModule,
    AuditLogModule,
    GoalsModule,
    ExpensesModule,
    TasksModule,
    PlatformModule,
    NotificationsModule,
    PushModule,
    QuotesModule,
    CustomerExecutiveModule,
    ReportsModule,
    SalesModule,
    CalendarModule,
    SettingsModule,
    InvoicesModule,
    CareersModule,
    OnboardingModule,
    WebhooksModule,
    ClientsModule,
    CrmModule,
    CrmMetadataModule,
    CrmPricebooksModule,
    CrmInboxModule,
    CrmAutomationStudioModule,
    FinanceReportsModule,
    DashboardModule,
    PublicModule,
    RbacModule,
    AccessModule,
    DealsModule,
    OrgModule,
    OrganizationModule,
    BranchesModule,
    ProjectsPortfoliosModule,
    ProjectsTeamsModule,
    ProjectsCommentDraftsModule,
    ProjectsExecutionModule,
    ProjectsQaModule,
    ProjectsClientPortalModule,
    ProjectsApprovalsModule,
    ProjectsGovernanceModule,
    ProjectsMeetingsModule,
    ProjectsIncidentsModule,
    ProjectsWorkflowModule,
    ProjectsFormsModule,
    ProjectsModule,
    ProjectsByIdModule,
    SupportModule,
    SignosModule,
    KbModule,
    AccountingModule,
    ChatModule,
    HrConfigModule,
    HrTimeModule,
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
    HrDirectoryModule,
    HrPerformanceModule,
    HrPayrollModule,
    HrLifecycleModule,
    SearchModule,
    IntegrationsGitModule,
    IntegrationsModule,
    CronModule,
    HrHelpdeskModule,
    HrRecruitmentModule,
    HrInterviewsModule,
    InvProductsModule,
    InvWarehousesModule,
    InvStockModule,
    InvVendorsModule,
    InvPurchaseOrdersModule,
    InvSalesOrdersModule,
    InvReportsModule,
    InvBarcodeModule,
    InvCountsModule,
    InvReturnsModule,
    InvTraceabilityModule,
    InvValuationModule,
    InvReplenishmentModule,
    InvAiModule,
    InvQualityModule,
    InvShipmentsModule,
    InvChannelsModule,
    InvImportExportModule,
    InvWebhooksModule,
    InvSettingsModule,
    EmailModule,
    AiModule,
    AiSummariesModule,
    WorkspaceSearchModule,
    SupportKbGapModule,
    StorageModule,
    BillingModule,
    RealtimeModule,
    AutomationModule,
    SessionsModule,
    MfaModule,
    AuthModule,
    FeatureFlagsModule,
    AiJobsModule,
    AiConfirmationModule,
    OrgHierarchyModule,
    ApiTokensModule,
    ServiceAccountsModule,
    UserApiTokensModule,
    TemporaryAccessModule,
    DelegationsModule,
    UsersModule,
    WorkspaceOnboardingModule,
    WorkflowsModule,
    PayrollModule,
    TimesheetsModule,
    TimesheetsCoreModule,
    PaymentsModule,
    FeedbucketModule,
    HrImportModule,
    FinanceExpensesModule,
    AccountingSettingsModule,
    AccountingGlModule,
    FinanceArModule,
    FinanceApModule,
    FinanceBankingModule,
    FinanceTaxModule,
    FinancePlanningModule,
    FinanceAssetsModule,
    FinanceControlsModule,
    AccountingAiModule,
    AgentAccessModule,
    MailModule,
  ],
  controllers: [HealthController, MeController],
  providers: [
    MeService,
    Reflector,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
