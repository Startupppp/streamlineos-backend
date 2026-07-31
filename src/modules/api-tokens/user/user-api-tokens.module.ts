import { Module } from "@nestjs/common";
import { UserApiTokensController } from "./user-api-tokens.controller";
import { UserApiTokensService } from "./user-api-tokens.service";
import { NotificationsModule } from "../../notifications/notifications.module";

@Module({
  imports: [NotificationsModule],
  controllers: [UserApiTokensController],
  providers: [UserApiTokensService],
  exports: [UserApiTokensService],
})
export class UserApiTokensModule {}
