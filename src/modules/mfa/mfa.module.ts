import { Module } from "@nestjs/common";
import { MfaController } from "./mfa.controller";
import { MfaService } from "./mfa.service";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [NotificationsModule],
  controllers: [MfaController],
  providers: [MfaService],
})
export class MfaModule {}
