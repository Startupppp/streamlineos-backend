import { Module } from "@nestjs/common";
import { DrizzleModule } from "../../db/drizzle.module";
import { PortalJwtAuthGuard } from "./portal-jwt-auth.guard";

@Module({
  imports: [DrizzleModule],
  providers: [PortalJwtAuthGuard],
  exports: [PortalJwtAuthGuard],
})
export class PortalAuthGuardModule {}
