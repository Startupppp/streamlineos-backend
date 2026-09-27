import { Global, Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { AccessService } from "./access.service";
import { AccessExplainResolver } from "./access-explain.resolver";
import { AccessVersionCache } from "./access-version-cache";
import { ManagerStandingReader } from "./manager-standing.reader";
import { EntitlementsService } from "./entitlements.service";
import { MfaPolicyService } from "./mfa-policy.service";
import { EntitlementsController } from "./entitlements.controller";
import { PermissionGuard } from "./permission.guard";
import { UserModuleAccessController } from "./user-module-access.controller";
import { UserModuleAccessService } from "./user-module-access.service";
import { BillingModule } from "../billing/core/billing.module";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { MODULE_AVAILABILITY_LOOKUP } from "../../common/auth/module-availability-lookup.token";
import { MODULE_ENTITLEMENTS } from "../../common/access/module-entitlements.token";
import { MFA_POLICY } from "../../common/auth/mfa-policy.token";

@Global()
@Module({
  imports: [BillingModule, DiscoveryModule],
  controllers: [EntitlementsController, UserModuleAccessController],
  providers: [
    AccessService,
    AccessExplainResolver,
    AccessVersionCache,
    ManagerStandingReader,
    EntitlementsService,
    MfaPolicyService,
    PermissionGuard,
    ModuleGuard,
    UserModuleAccessService,
    { provide: MODULE_AVAILABILITY_LOOKUP, useExisting: AccessService },
    { provide: MODULE_ENTITLEMENTS, useExisting: EntitlementsService },
    { provide: MFA_POLICY, useExisting: MfaPolicyService },
  ],
  exports: [
    AccessService,
    AccessExplainResolver,
    EntitlementsService,
    MfaPolicyService,
    PermissionGuard,
    ModuleGuard,
    UserModuleAccessService,
    MODULE_AVAILABILITY_LOOKUP,
    MODULE_ENTITLEMENTS,
    MFA_POLICY,
  ],
})
export class AccessModule {}
