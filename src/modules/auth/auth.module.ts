import { Module } from "@nestjs/common";

import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { AuthMembershipResolverService } from "./auth-membership-resolver.service";
import { AuthPasswordlessService } from "./auth-passwordless.service";
import { AuthGoogleOAuthService } from "./auth-google-oauth.service";
import { AuthAnalyticsService } from "./auth-analytics.service";
import { RateLimitModule } from "../../common/ratelimit/rate-limit.module";
import { SessionsModule } from "../sessions/sessions.module";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  controllers: [AuthController],
  imports: [RateLimitModule, NotificationsModule, SessionsModule],
  exports: [AuthService, AuthMembershipResolverService],
  providers: [
    AuthService,
    AuthMembershipResolverService,
    AuthPasswordlessService,
    AuthGoogleOAuthService,
    AuthAnalyticsService,
  ],
})
export class AuthModule {}
