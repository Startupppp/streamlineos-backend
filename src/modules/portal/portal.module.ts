import { Module } from "@nestjs/common";
import { PortalAccessModule } from "./access/portal-access.module";
import { PortalAuthModule } from "./auth/portal-auth.module";
import { PortalClientModule } from "./client/portal-client.module";

const PORTAL_MODULES = [PortalAccessModule, PortalAuthModule, PortalClientModule];

@Module({
  imports: PORTAL_MODULES,
  exports: PORTAL_MODULES,
})
export class PortalModule {}
