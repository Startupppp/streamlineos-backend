import { Module } from "@nestjs/common";
import { MfaController } from "./mfa.controller";
import { MfaService } from "./mfa.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { RateLimitModule } from "../../common/ratelimit/rate-limit.module";

@Module({
  imports: [RateLimitModule, NotificationsModule],
  controllers: [MfaController],
  providers: [MfaService],
})
export class MfaModule {}
