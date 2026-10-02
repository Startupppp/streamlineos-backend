import { Module } from "@nestjs/common";
import { ClientPortalController } from "./client-portal.controller";
import { ChangeRequestsController } from "./change-requests.controller";
import { ChangeRequestAffectedItemsController } from "./change-request-affected-items.controller";
import { ClientVisibilityController } from "./client-visibility.controller";
import { ClientPortalManagementController } from "./client-portal-management.controller";
import { ClientPortalService } from "./client-portal.service";
import { ChangeRequestsService } from "./change-requests.service";
import { ChangeRequestAffectedItemsService } from "./change-request-affected-items.service";
import { ClientVisibilityService } from "./client-visibility.service";
import { ClientPortalManagementService } from "./client-portal-management.service";
import { PortalProjectionService } from "./portal-projection.service";

@Module({
  controllers: [
    ClientPortalController,
    ChangeRequestsController,
    ChangeRequestAffectedItemsController,
    ClientVisibilityController,
    ClientPortalManagementController,
  ],
  providers: [
    ClientPortalService,
    ChangeRequestsService,
    ChangeRequestAffectedItemsService,
    ClientVisibilityService,
    ClientPortalManagementService,
    PortalProjectionService,
  ],
  exports: [PortalProjectionService],
})
export class BuildClientPortalModule {}
