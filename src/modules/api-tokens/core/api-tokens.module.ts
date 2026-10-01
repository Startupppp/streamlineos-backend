import { Module } from "@nestjs/common";
import { ApiTokensController } from "./api-tokens.controller";
import { ApiTokensService } from "./api-tokens.service";
import { NotificationsModule } from "../../notifications/notifications.module";

@Module({
  imports: [NotificationsModule],
  controllers: [ApiTokensController],
  providers: [ApiTokensService],
  exports: [ApiTokensService],
})
export class ApiTokensModule {}
