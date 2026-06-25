import { Module } from "@nestjs/common";
import { ConfigModule } from "./config/config.module";
import { DrizzleModule } from "./db/drizzle.module";
import { CacheModule } from "./common/cache/cache.module";
import { AuditModule } from "./common/audit/audit.module";
import { RateLimitModule } from "./common/ratelimit/rate-limit.module";
import { LeadsModule } from "./modules/leads/leads.module";
import { HealthController } from "./health/health.controller";
import { MeController } from "./me/me.controller";

@Module({
  imports: [ConfigModule, DrizzleModule, CacheModule, AuditModule, RateLimitModule, LeadsModule],
  controllers: [HealthController, MeController],
})
export class AppModule {}
