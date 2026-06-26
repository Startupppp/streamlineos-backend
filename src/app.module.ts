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
  ],
  controllers: [HealthController, MeController],
})
export class AppModule {}
