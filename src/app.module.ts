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
import { ProjectsModule } from "./modules/projects/projects.module";
import { SupportModule } from "./modules/support/support.module";
import { KbModule } from "./modules/kb/kb.module";
import { AccountingModule } from "./modules/accounting/accounting.module";
import { ChatModule } from "./modules/chat/chat.module";
import { HrConfigModule } from "./modules/hr-config/hr-config.module";
import { HrTimeModule } from "./modules/hr-time/hr-time.module";
import { HrDirectoryModule } from "./modules/hr-directory/hr-directory.module";
import { HrPerformanceModule } from "./modules/hr-performance/hr-performance.module";
import { HrPayrollModule } from "./modules/hr-payroll/hr-payroll.module";
import { HrLifecycleModule } from "./modules/hr-lifecycle/hr-lifecycle.module";
import { SearchModule } from "./modules/search/search.module";
import { IntegrationsGitModule } from "./modules/integrations-git/integrations-git.module";
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
import { EmailModule } from "./modules/email/email.module";
import { AiModule } from "./modules/ai/ai.module";
import { StorageModule } from "./modules/storage/storage.module";
import { BillingModule } from "./modules/billing/billing.module";
import { GoogleCalendarModule } from "./modules/google-calendar/google-calendar.module";
import { CalendarConnectionsModule } from "./modules/calendar-connections/calendar-connections.module";
import { RealtimeModule } from "./modules/realtime/realtime.module";
import { AutomationModule } from "./modules/automation/automation.module";
import { SessionsModule } from "./modules/sessions/sessions.module";
import { MfaModule } from "./modules/mfa/mfa.module";
import { AuthModule } from "./modules/auth/auth.module";
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
    DashboardModule,
    PublicModule,
    RbacModule,
    AccessModule,
    DealsModule,
    OrgModule,
    OrganizationModule,
    BranchesModule,
    ProjectsExecutionModule,
    ProjectsModule,
    SupportModule,
    KbModule,
    AccountingModule,
    ChatModule,
    HrConfigModule,
    HrTimeModule,
    HrDirectoryModule,
    HrPerformanceModule,
    HrPayrollModule,
    HrLifecycleModule,
    SearchModule,
    IntegrationsGitModule,
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
    EmailModule,
    AiModule,
    StorageModule,
    BillingModule,
    GoogleCalendarModule,
    CalendarConnectionsModule,
    RealtimeModule,
    AutomationModule,
    SessionsModule,
    MfaModule,
    AuthModule,
  ],
  controllers: [HealthController, MeController],
  providers: [
    MeService,
    Reflector,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
