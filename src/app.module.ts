import { Module } from "@nestjs/common";
import { ConfigModule } from "./config/config.module";
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
import { DealsModule } from "./modules/deals/deals.module";
import { OrgModule } from "./modules/org/org.module";
import { OrganizationModule } from "./modules/organization/organization.module";
import { BranchesModule } from "./modules/branches/branches.module";
import { ProjectsExecutionModule } from "./modules/projects-execution/projects-execution.module";
import { ProjectsModule } from "./modules/projects/projects.module";
import { SupportModule } from "./modules/support/support.module";
import { AccountingModule } from "./modules/accounting/accounting.module";
import { ChatModule } from "./modules/chat/chat.module";
import { HealthController } from "./health/health.controller";
import { MeController } from "./me/me.controller";

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
    DealsModule,
    OrgModule,
    OrganizationModule,
    BranchesModule,
    ProjectsExecutionModule,
    ProjectsModule,
    SupportModule,
    AccountingModule,
    ChatModule,
  ],
  controllers: [HealthController, MeController],
})
export class AppModule {}
