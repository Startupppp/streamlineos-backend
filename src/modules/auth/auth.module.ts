import { Module } from "@nestjs/common";

import { AuthService } from "./auth.service";
import { DeviceService } from "./device.service";
import { AuthController } from "./auth.controller";
import { SessionService } from "./session.service";
import { AuthTokensService } from "./auth-tokens.service";
import { RateLimitModule } from "../../common/ratelimit/rate-limit.module";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  controllers: [AuthController],
  imports: [RateLimitModule, NotificationsModule],
  exports: [AuthService, AuthTokensService, SessionService, DeviceService],
  providers: [AuthService, AuthTokensService, SessionService, DeviceService],
})
export class AuthModule {}
