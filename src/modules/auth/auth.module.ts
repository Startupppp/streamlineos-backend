import { Module } from "@nestjs/common";

import { AuthService } from "./auth.service";
import { DeviceService } from "./device.service";
import { AuthController } from "./auth.controller";
import { AuthTokensService } from "./auth-tokens.service";
import { RateLimitModule } from "../../common/ratelimit/rate-limit.module";
import { SessionsModule } from "../sessions/sessions.module";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  controllers: [AuthController],
  imports: [RateLimitModule, NotificationsModule, SessionsModule],
  exports: [AuthService, AuthTokensService, DeviceService],
  providers: [AuthService, AuthTokensService, DeviceService],
})
export class AuthModule {}
