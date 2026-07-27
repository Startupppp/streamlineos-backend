import { Module } from "@nestjs/common";
import { DrizzleModule } from "../../db/drizzle.module";
import { PortalAuthController } from "./portal-auth.controller";
import { PortalAuthService } from "./portal-auth.service";
import { PortalTokenService } from "./portal-token.service";

@Module({
  imports: [DrizzleModule],
  controllers: [PortalAuthController],
  providers: [PortalAuthService, PortalTokenService],
  exports: [PortalTokenService],
})
export class PortalAuthModule {}
