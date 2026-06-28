import { Global, Module } from "@nestjs/common";
import { AccessService } from "./access.service";
import { EntitlementsService } from "./entitlements.service";
import { EntitlementsController } from "./entitlements.controller";
import { PermissionGuard } from "./permission.guard";
import { ResourceGrantsService } from "./resource-grants.service";
import { ResourceGrantsController } from "./resource-grants.controller";

@Global()
@Module({
  controllers: [EntitlementsController, ResourceGrantsController],
  providers: [AccessService, EntitlementsService, PermissionGuard, ResourceGrantsService],
  exports: [AccessService, EntitlementsService, PermissionGuard, ResourceGrantsService],
})
export class AccessModule {}
