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
  ],
  controllers: [HealthController, MeController],
})
export class AppModule {}
