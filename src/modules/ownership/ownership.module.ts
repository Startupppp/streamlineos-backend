import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { OwnershipController } from "./ownership.controller";
import { OwnershipService } from "./ownership.service";
import { OwnershipTransfersService } from "./ownership-transfers.service";
import { OwnershipTransferResponseService } from "./ownership-transfer-response.service";
import { OrganizationSagaService } from "../organization/core/lifecycle/organization-saga.service";

@Module({
  imports: [NotificationsModule],
  controllers: [OwnershipController],
  providers: [
    OwnershipService,
    OwnershipTransfersService,
    OwnershipTransferResponseService,
    OrganizationSagaService,
  ],
  exports: [
    OwnershipService,
    OwnershipTransfersService,
    OwnershipTransferResponseService,
  ],
})
export class OwnershipModule {}
