import { Module } from "@nestjs/common";
import { ClientPortalController } from "./client-portal.controller";
import { ChangeRequestsController } from "./change-requests.controller";
import { ClientVisibilityController } from "./client-visibility.controller";
import { ClientPortalService } from "./client-portal.service";
import { ChangeRequestsService } from "./change-requests.service";
import { ClientVisibilityService } from "./client-visibility.service";

@Module({
  controllers: [
    ClientPortalController,
    ChangeRequestsController,
    ClientVisibilityController,
  ],
  providers: [
    ClientPortalService,
    ChangeRequestsService,
    ClientVisibilityService,
  ],
})
export class BuildClientPortalModule {}
