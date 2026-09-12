import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { AuthEmailVerificationService } from "./auth-email-verification.service";
import { AuthMagicLinkService } from "./auth-magic-link.service";
import { AuthEmailOtpService } from "./auth-email-otp.service";
import { AuthMembershipResolverService } from "./auth-membership-resolver.service";
import { AuthAnalyticsService } from "./auth-analytics.service";
import { RateLimitModule } from "../../common/ratelimit/rate-limit.module";
import { SessionsModule } from "../sessions/sessions.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { OrganizationModule } from "../organization/core/organization.module";

@Module({
  controllers: [AuthController],
  imports: [RateLimitModule, NotificationsModule, SessionsModule, OrganizationModule],
  exports: [AuthService],
  providers: [
    AuthService,
    AuthEmailVerificationService,
    AuthMagicLinkService,
    AuthEmailOtpService,
    AuthMembershipResolverService,
    AuthAnalyticsService,
  ],
})
export class AuthModule {}
