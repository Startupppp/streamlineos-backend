import { Module } from "@nestjs/common";
import { ConfigModule } from "./config/config.module";
import { DrizzleModule } from "./db/drizzle.module";
import { HealthController } from "./health/health.controller";

@Module({
  imports: [ConfigModule, DrizzleModule],
  controllers: [HealthController],
})
export class AppModule {}
