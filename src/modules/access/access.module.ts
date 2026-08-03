import { Global, Module } from "@nestjs/common";
import { AccessService } from "./access.service";
import { EntitlementsService } from "./entitlements.service";
import { MfaPolicyService } from "./mfa-policy.service";
import { EntitlementsController } from "./entitlements.controller";
import { PermissionGuard } from "./permission.guard";
import { UserModuleAccessController } from "./user-module-access.controller";
import { BillingModule } from "../billing/core/billing.module";
import { ModuleGuard } from "../../common/rbac/module.guard";

@Global()
@Module({
  imports: [BillingModule],
  controllers: [EntitlementsController, UserModuleAccessController],
  providers: [
    AccessService,
    EntitlementsService,
    MfaPolicyService,
    PermissionGuard,
    ModuleGuard,
  ],
  exports: [
    AccessService,
    EntitlementsService,
    MfaPolicyService,
    PermissionGuard,
    ModuleGuard,
  ],
})
export class AccessModule {}
