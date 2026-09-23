import { Module } from "@nestjs/common";
import { ClientPortalController } from "./client-portal.controller";
import { ChangeRequestsController } from "./change-requests.controller";
import { ChangeRequestAffectedItemsController } from "./change-request-affected-items.controller";
import { ClientVisibilityController } from "./client-visibility.controller";
import { ClientPortalService } from "./client-portal.service";
import { ChangeRequestsService } from "./change-requests.service";
import { ChangeRequestAffectedItemsService } from "./change-request-affected-items.service";
import { ClientVisibilityService } from "./client-visibility.service";

@Module({
  controllers: [
    ClientPortalController,
    ChangeRequestsController,
    ChangeRequestAffectedItemsController,
    ClientVisibilityController,
  ],
  providers: [
    ClientPortalService,
    ChangeRequestsService,
    ChangeRequestAffectedItemsService,
    ClientVisibilityService,
  ],
})
export class BuildClientPortalModule {}
