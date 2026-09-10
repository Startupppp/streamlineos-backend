import { Module } from "@nestjs/common";

import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { AuthTokensService } from "./auth-tokens.service";
import { RateLimitModule } from "../../common/ratelimit/rate-limit.module";
import { SessionsModule } from "../sessions/sessions.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { OrganizationModule } from "../organization/core/organization.module";

@Module({
  controllers: [AuthController],
  imports: [RateLimitModule, NotificationsModule, SessionsModule, OrganizationModule],
  exports: [AuthService, AuthTokensService],
  providers: [AuthService, AuthTokensService],
})
export class AuthModule {}
