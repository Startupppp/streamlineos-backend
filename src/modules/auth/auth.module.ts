import { Module } from "@nestjs/common";
<<<<<<< HEAD
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

@Module({ controllers: [AuthController], providers: [AuthService] })
=======
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { PasswordService } from "./password.service";
import { SessionService } from "./session.service";
import { DeviceService } from "./device.service";
import { RateLimitModule } from "../../common/ratelimit/rate-limit.module";

@Module({
  imports: [RateLimitModule],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, SessionService, DeviceService],
  exports: [AuthService, PasswordService, SessionService, DeviceService],
})
>>>>>>> 8268f32a22460c71f19892e240ad061afc54b8c8
export class AuthModule {}
