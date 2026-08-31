import { Module } from "@nestjs/common";
import { PlatformController } from "./platform.controller";
import { PlatformService } from "./platform.service";
import { PlatformAnalyticsService } from "./platform-analytics.service";
import { PlatformAdminService } from "./platform-admin.service";
import { PlatformOperatorAccessService } from "./platform-operator-access.service";

@Module({
  controllers: [PlatformController],
  providers: [PlatformService, PlatformAnalyticsService, PlatformAdminService, PlatformOperatorAccessService],
  exports: [PlatformService, PlatformAnalyticsService, PlatformAdminService, PlatformOperatorAccessService],
})
export class PlatformModule {}
