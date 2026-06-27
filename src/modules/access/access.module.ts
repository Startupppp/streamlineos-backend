import { Global, Module } from "@nestjs/common";
import { AccessService } from "./access.service";
import { PermissionGuard } from "./permission.guard";

@Global()
@Module({
  providers: [AccessService, PermissionGuard],
  exports: [AccessService, PermissionGuard],
})
export class AccessModule {}
