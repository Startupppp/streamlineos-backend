import { Module } from "@nestjs/common";
import { PlatformController } from "./platform.controller";
import { PlatformService } from "./platform.service";
import { PlatformAnalyticsService } from "./platform-analytics.service";
import { PlatformAdminService } from "./platform-admin.service";
import { PlatformOperatorAccessService } from "./platform-operator-access.service";
import { PlatformOperatorAccessController } from "./platform-operator-access.controller";
import { OperatorSessionGuard } from "./operator-session.guard";
import { PlatformOperatorCustomerController } from "./platform-operator-customer.controller";
import { PlatformOperatorCustomerService } from "./platform-operator-customer.service";

@Module({
  controllers: [
    PlatformController,
    PlatformOperatorAccessController,
    PlatformOperatorCustomerController,
  ],
  providers: [
    PlatformService,
    PlatformAnalyticsService,
    PlatformAdminService,
    PlatformOperatorAccessService,
    PlatformOperatorCustomerService,
    OperatorSessionGuard,
  ],
  exports: [PlatformService, PlatformAnalyticsService, PlatformAdminService, PlatformOperatorAccessService],
})
export class PlatformModule {}
