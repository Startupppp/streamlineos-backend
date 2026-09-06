import { Global, Module } from "@nestjs/common";
import { AccessService } from "./access.service";
import { AccessVersionCache } from "./access-version-cache";
import { EntitlementsService } from "./entitlements.service";
import { MfaPolicyService } from "./mfa-policy.service";
import { EntitlementsController } from "./entitlements.controller";
import { PermissionGuard } from "./permission.guard";
import { UserModuleAccessController } from "./user-module-access.controller";
import { UserModuleAccessService } from "./user-module-access.service";
import { BillingModule } from "../billing/core/billing.module";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { MODULE_GUARD_ACCESS } from "../../common/rbac/module-guard.token";
import { MODULE_ENTITLEMENTS } from "../../common/access/module-entitlements.token";
import { MFA_POLICY } from "../../common/auth/mfa-policy.token";

@Global()
@Module({
  imports: [BillingModule],
  controllers: [EntitlementsController, UserModuleAccessController],
  providers: [
    AccessService,
    AccessVersionCache,
    EntitlementsService,
    MfaPolicyService,
    PermissionGuard,
    ModuleGuard,
    UserModuleAccessService,
    { provide: MODULE_GUARD_ACCESS, useExisting: AccessService },
    { provide: MODULE_ENTITLEMENTS, useExisting: EntitlementsService },
    { provide: MFA_POLICY, useExisting: MfaPolicyService },
  ],
  exports: [
    AccessService,
    EntitlementsService,
    MfaPolicyService,
    PermissionGuard,
    ModuleGuard,
    UserModuleAccessService,
    MODULE_GUARD_ACCESS,
    MODULE_ENTITLEMENTS,
    MFA_POLICY,
  ],
})
export class AccessModule {}
