import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR, DiscoveryModule } from "@nestjs/core";
import { RouteClassifierGuard } from "./common/auth/route-classifier.guard";
import {
  TenantContextInterceptor,
  TenantContextService,
} from "./common/tenant";
import { Reflector } from "@nestjs/core";

import { DeprecationInterceptor } from "./common/deprecation/deprecation.interceptor";
import { ObservabilityEnrichmentInterceptor } from "./common/observability";
import { RegionModule } from "./common/region/region.module";
import { WorkflowModule } from "./common/workflow";
import { ConfigModule } from "./config/config.module";
import { JwtAuthGuard } from "./common/auth/jwt-auth.guard";
import { AuthContextModule } from "./common/auth/auth-context.module";
import { MfaGuard } from "./common/auth/mfa.guard";
import { ModuleGuard } from "./common/rbac/module.guard";
import { DrizzleModule } from "./db/drizzle.module";
import { CacheModule } from "./common/cache/cache.module";
import { AuditModule } from "./common/audit/audit.module";
import { RateLimitModule } from "./common/ratelimit/rate-limit.module";
import { AdmissionModule } from "./common/admission/admission.module";
import { AdmissionGuard } from "./common/admission/admission.guard";
import { AdmissionInterceptor } from "./common/admission/admission.interceptor";
import { LeadsModule } from "./modules/leads/leads.module";
import { ContactsModule } from "./modules/contacts/contacts.module";
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
import { ReportsModule } from "./modules/reports/reports.module";
import { SalesModule } from "./modules/sales/sales.module";
import { CalendarModule } from "./modules/calendar/calendar.module";
import { SettingsModule } from "./modules/settings/settings.module";
import { InvoicesModule } from "./modules/invoices/invoices.module";
import { CareersModule } from "./modules/careers/careers.module";
import { WebhooksModule } from "./modules/webhooks/webhooks.module";
import { ClientsModule } from "./modules/clients/clients.module";
import { CrmRootModule } from "./modules/crm/crm.module";
import { DashboardModule } from "./modules/dashboard/dashboard.module";
import { PublicModule } from "./modules/public/public.module";
import { RbacModule } from "./modules/rbac/rbac.module";
import { AccessModule } from "./modules/access/access.module";
import { DealsModule } from "./modules/deals/deals.module";
import { OrganizationRootModule } from "./modules/organization/organization.module";
import { OwnershipModule } from "./modules/ownership/ownership.module";
import { BranchesModule } from "./modules/branches/branches.module";
import { CustomerExecutiveModule } from "./modules/customer-executive/customer-executive.module";
import { OfferFulfillmentModule } from "./modules/offer-fulfillment/offer-fulfillment.module";
import { SupportRootModule } from "./modules/support/support.module";
import { ESignModule } from "./modules/e-sign/e-sign.module";
import { KbModule } from "./modules/kb/kb.module";
import { AccountingRootModule } from "./modules/accounting/accounting.module";
import { ChatModule } from "./modules/chat/chat.module";
import { HrModule } from "./modules/hr/hr.module";
import { SearchModule } from "./modules/search/search.module";
import { IntegrationsRootModule } from "./modules/integrations/integrations.module";
import { CronModule } from "./modules/cron/cron.module";
import { InventoryModule } from "./modules/inventory/inventory.module";
import { EmailModule } from "./modules/email/email.module";
import { AiRootModule } from "./modules/ai/ai.module";
import { StorageModule } from "./modules/storage/storage.module";
import { BillingRootModule } from "./modules/billing/billing.module";
import { RealtimeModule } from "./modules/realtime/realtime.module";
import { AutomationModule } from "./modules/automation/automation.module";
import { SessionsModule } from "./modules/sessions/sessions.module";
import { MfaModule } from "./modules/mfa/mfa.module";
import { AuthModule } from "./modules/auth/auth.module";
import { ApiTokensRootModule } from "./modules/api-tokens/api-tokens.module";
import { DelegationsModule } from "./modules/delegations/delegations.module";
import { UsersModule } from "./modules/users/users.module";
import { WorkflowsModule } from "./modules/workflows/workflows.module";
import { PayrollModule } from "./modules/payroll/payroll.module";
import { TimesheetsRootModule } from "./modules/timesheets/timesheets.module";
import { FeedbucketModule } from "./modules/feedbucket/feedbucket.module";
import { FinanceModule } from "./modules/finance/finance.module";
import { AgentAccessModule } from "./modules/agent-access/agent-access.module";
import { MailModule } from "./modules/mail/mail.module";
import { DirectoryModule } from "./modules/directory/directory.module";
import { PartyModule } from "./modules/party/party.module";
import { ActivitiesModule } from "./modules/activities/activities.module";
import { IngressModule } from "./modules/ingress/ingress.module";
import { AutonomyModule } from "./modules/autonomy/autonomy.module";
import { CrmImportModule } from "./modules/crm/import/crm-import.module";
import { PortalModule } from "./modules/portal/portal.module";
import { ModuleAccessModule } from "./modules/module-access/module-access.module";
import { IdempotencyModule } from "./common/idempotency/idempotency.module";
import { IdempotencyInterceptor } from "./common/idempotency/idempotency.interceptor";
import { OutboxModule } from "./common/outbox/outbox.module";
import { HealthController } from "./health/health.controller";
import { MeController } from "./me/me.controller";
import { MeService } from "./me/me.service";
import { InboxController } from "./me/inbox.controller";
import { BuildModule } from "./modules/build/build.module";
import { ZodValidationInterceptor } from "./common/validation/zod-validation.interceptor";
import { DataQualityModule } from "./modules/data-quality/data-quality.module";
import { IssuesModule } from "./modules/issues/issues.module";
import { RecordLayoutsModule } from "./modules/record-layouts/record-layouts.module";
import { EmploymentFactsModule } from "./modules/directory/employment-facts.module";

@Module({
  imports: [
    EmploymentFactsModule,
    DiscoveryModule,
    RegionModule,
    WorkflowModule,
    ConfigModule,
    DrizzleModule,
    CacheModule,
    AuditModule,
    LeadsModule,
    BlogModule,
    CsatModule,
    SurveysModule,
    ContactsModule,
    RateLimitModule,
    AdmissionModule,
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
    WebhooksModule,
    ClientsModule,
    CrmRootModule,
    FinanceModule,
    DashboardModule,
    PublicModule,
    RbacModule,
    AuthContextModule,
    AccessModule,
    DealsModule,
    OrganizationRootModule,
    OwnershipModule,
    BranchesModule,
    BuildModule,
    OfferFulfillmentModule,
    SupportRootModule,
    ESignModule,
    KbModule,
    AccountingRootModule,
    ChatModule,
    HrModule,
    DirectoryModule,
    PartyModule,
    DataQualityModule,
    ActivitiesModule,
    IngressModule,
    AutonomyModule,
    CrmImportModule,
    IssuesModule,
    RecordLayoutsModule,
    PortalModule,
    ModuleAccessModule,
    IdempotencyModule,
    OutboxModule,
    SearchModule,
    IntegrationsRootModule,
    CronModule,
    InventoryModule,
    EmailModule,
    AiRootModule,
    StorageModule,
    BillingRootModule,
    RealtimeModule,
    AutomationModule,
    SessionsModule,
    MfaModule,
    AuthModule,
    ApiTokensRootModule,
    DelegationsModule,
    UsersModule,
    WorkflowsModule,
    PayrollModule,
    TimesheetsRootModule,
    FeedbucketModule,
    AgentAccessModule,
    MailModule,
  ],
  controllers: [HealthController, MeController, InboxController],
  providers: [
    MeService,
    Reflector,
    TenantContextService,
    { provide: APP_GUARD, useClass: RouteClassifierGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: AdmissionGuard },
    { provide: APP_GUARD, useClass: MfaGuard },
    { provide: APP_GUARD, useClass: ModuleGuard },
    { provide: APP_INTERCEPTOR, useClass: AdmissionInterceptor },
    // First interceptor to run, so everything after it logs under a known caller.
    { provide: APP_INTERCEPTOR, useClass: ObservabilityEnrichmentInterceptor },
    { provide: APP_INTERCEPTOR, useClass: DeprecationInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ZodValidationInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
