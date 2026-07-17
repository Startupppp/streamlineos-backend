import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthTokensService } from "./auth-tokens.service";
import { AuthController } from "./auth.controller";
import { SessionService } from "./session.service";
import { DeviceService } from "./device.service";
import { RateLimitModule } from "../../common/ratelimit/rate-limit.module";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [RateLimitModule, NotificationsModule],
  controllers: [AuthController],
  providers: [AuthService, AuthTokensService, SessionService, DeviceService],
  exports: [AuthService, AuthTokensService, SessionService, DeviceService],
})
export class AuthModule {}
