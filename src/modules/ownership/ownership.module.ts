import { Module } from "@nestjs/common";
import { OwnershipController } from "./ownership.controller";
import { OwnershipService } from "./ownership.service";

@Module({
  controllers: [OwnershipController],
  providers: [OwnershipService],
  exports: [OwnershipService],
})
export class OwnershipModule {}
