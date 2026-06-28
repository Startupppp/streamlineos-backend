import { Module } from "@nestjs/common";
import { ServiceAccountsController } from "./service-accounts.controller";
import { ServiceAccountsService } from "./service-accounts.service";

@Module({
  controllers: [ServiceAccountsController],
  providers: [ServiceAccountsService],
})
export class ServiceAccountsModule {}
