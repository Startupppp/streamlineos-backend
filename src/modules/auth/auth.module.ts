import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { PasswordService } from "./password.service";
import { SessionService } from "./session.service";
import { DeviceService } from "./device.service";

@Module({
  controllers: [AuthController],
  providers: [AuthService, PasswordService, SessionService, DeviceService],
  exports: [AuthService, PasswordService, SessionService, DeviceService],
})
export class AuthModule {}
