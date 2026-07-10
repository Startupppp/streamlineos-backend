import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthTokensService } from "./auth-tokens.service";
import { AuthController } from "./auth.controller";
import { PasswordService } from "./password.service";
import { SessionService } from "./session.service";
import { DeviceService } from "./device.service";
import { RateLimitModule } from "../../common/ratelimit/rate-limit.module";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [RateLimitModule, NotificationsModule],
  controllers: [AuthController],
  providers: [AuthService, AuthTokensService, PasswordService, SessionService, DeviceService],
  exports: [AuthService, AuthTokensService, PasswordService, SessionService, DeviceService],
})
export class AuthModule {}
