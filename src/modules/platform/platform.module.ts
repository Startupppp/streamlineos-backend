import { Module } from "@nestjs/common";
import { PlatformController } from "./platform.controller";
import { PlatformService } from "./platform.service";
import { PlatformAnalyticsService } from "./platform-analytics.service";
import { PlatformAdminService } from "./platform-admin.service";

@Module({
  controllers: [PlatformController],
  providers: [PlatformService, PlatformAnalyticsService, PlatformAdminService],
  exports: [PlatformService, PlatformAnalyticsService, PlatformAdminService],
})
export class PlatformModule {}
