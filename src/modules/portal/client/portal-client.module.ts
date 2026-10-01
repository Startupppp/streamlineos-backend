import { Module } from "@nestjs/common";
import { DrizzleModule } from "../../../db/drizzle.module";
import { PortalAuthGuardModule } from "../../../common/portal-auth/portal-auth.module";
import { BuildClientPortalModule } from "../../build/client-portal/build-client-portal.module";
import { PortalClientController } from "./portal-client.controller";
import { PortalClientService } from "./portal-client.service";

@Module({
  imports: [DrizzleModule, PortalAuthGuardModule, BuildClientPortalModule],
  controllers: [PortalClientController],
  providers: [PortalClientService],
})
export class PortalClientModule {}
